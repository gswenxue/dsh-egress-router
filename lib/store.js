/**
 * Durable state for dsh-egress-router.
 *
 * One JSON document holds the node library, the routing policy, and the local
 * ports. Reads are lazy and cached; every mutation rewrites the whole file
 * through a temp file + rename and mutations are serialized, so two concurrent
 * RPC calls (or an RPC racing the agent's tool call) cannot interleave a
 * half-written library onto disk.
 *
 * @module dsh-egress-router/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Routing modes, in the order the Settings panel shows them. */
export const MODES = ['off', 'auto', 'always']

/** Default router port: the local HTTP proxy every consumer points at. */
export const DEFAULT_ROUTER_PORT = 30810
/** Default sing-box mixed inbound port (HTTP + SOCKS5). */
export const DEFAULT_MIXED_PORT = 30811
/** Default sing-box Clash API port (selection and latency tests). */
export const DEFAULT_CLASH_PORT = 30812

/**
 * Domains the `auto` mode always sends through a node. Each entry matches the
 * name itself and every subdomain, so `github.com` covers `api.github.com`.
 */
export const DEFAULT_ROUTES = [
	'github.com',
	'githubusercontent.com',
	'githubassets.com',
	'github.io',
	'ghcr.io',
	'codeload.github.com',
	'objects.githubusercontent.com',
	'huggingface.co',
	'hf.co',
	'openai.com',
	'anthropic.com',
	'google.com',
	'googleapis.com',
	'gstatic.com',
	'youtube.com',
	'x.com',
	'twitter.com',
	'telegram.org'
]

/** Protocols a persisted node may declare. */
const PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'ss'])
/** Node-id shape, matching what this plugin mints. */
const ID_PATTERN = /^n_[A-Za-z0-9]{4,64}$/
/** How many nodes one library may hold. */
const MAX_NODES = 200
/** How many routing domains one policy may hold. */
const MAX_ROUTES = 200
/** Longest remark this plugin stores (UTF-16 units, cut mid-surrogate at worst is fine for display). */
const MAX_REMARK = 120

/** Resolve the durable data directory, mirroring DSH's own `dshHome` precedence. */
export function defaultDataDir() {
	const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh')
	// Deliberately not renamed with the package: this path holds the user's node
	// library, and moving it would silently drop every imported node.
	return resolve(home, 'integrations', 'dsh-net-proxy')
}

/**
 * Accept a mirror base URL for core downloads: an http(s) address serving the
 * same asset names as the release. Empty means "use the pinned GitHub release".
 */
function sanitizeMirror(value) {
	const text = typeof value === 'string' ? value.trim().slice(0, 300) : ''
	return /^https?:\/\/[^\s]+$/.test(text) ? text : ''
}

/** Clamp a persisted port, falling back to the default. */
function sanitizePort(value, fallback) {
	const port = Number(value)
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

/** Normalize one routing entry: lowercase, no scheme, no path. */
export function normalizeRoute(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
		.split('/')[0]
		.replace(/^\*\./, '')
		.replace(/\.$/, '')
}

/** Accept one persisted node, or `undefined` when the record is unusable. */
function sanitizeNode(value) {
	if (value === null || typeof value !== 'object') return undefined
	const id = typeof value.id === 'string' && ID_PATTERN.test(value.id) ? value.id : undefined
	const link = typeof value.link === 'string' ? value.link.trim() : ''
	const protocol = typeof value.protocol === 'string' && PROTOCOLS.has(value.protocol) ? value.protocol : undefined
	const server = typeof value.server === 'string' ? value.server.trim() : ''
	const port = Number(value.port)
	if (id === undefined || link === '' || protocol === undefined || server === '' || !Number.isInteger(port)) return undefined
	const lastTest = value.lastTest
	const sanitizedTest =
		lastTest !== null && typeof lastTest === 'object' && typeof lastTest.at === 'string'
			? {
					at: lastTest.at,
					ok: lastTest.ok === true,
					ms: Number.isFinite(lastTest.ms) ? Number(lastTest.ms) : null,
					error: typeof lastTest.error === 'string' && lastTest.error !== '' ? lastTest.error : null,
					// True when the failure was this machine's limitation (no IPv6 egress,
					// bad local port) rather than the node's: such a record never marks a
					// node 失效 and never excludes it from the candidates.
					local: lastTest.local === true
				}
			: null
	return {
		id,
		remark: (typeof value.remark === 'string' ? value.remark : '').trim().slice(0, MAX_REMARK),
		link,
		protocol,
		server,
		port,
		addedAt: typeof value.addedAt === 'string' ? value.addedAt : new Date().toISOString(),
		lastTest: sanitizedTest
	}
}

/** Coerce arbitrary parsed JSON into a usable state document. */
function sanitizeState(parsed) {
	const raw = Array.isArray(parsed?.nodes) ? parsed.nodes : []
	const nodes = []
	const seenIds = new Set()
	const seenLinks = new Set()
	for (const entry of raw) {
		const node = sanitizeNode(entry)
		if (node === undefined || seenIds.has(node.id) || seenLinks.has(node.link)) continue
		seenIds.add(node.id)
		seenLinks.add(node.link)
		nodes.push(node)
		if (nodes.length >= MAX_NODES) break
	}
	const routes = []
	for (const entry of Array.isArray(parsed?.routes) ? parsed.routes : DEFAULT_ROUTES) {
		const route = normalizeRoute(entry)
		if (route === '' || routes.includes(route)) continue
		routes.push(route)
		if (routes.length >= MAX_ROUTES) break
	}
	const mode = MODES.includes(parsed?.mode) ? parsed.mode : 'auto'
	const selectedId =
		typeof parsed?.selectedId === 'string' && seenIds.has(parsed.selectedId) ? parsed.selectedId : null
	return {
		version: 1,
		mode,
		selectedId,
		injectShellEnv: parsed?.injectShellEnv !== false,
		coreMirror: sanitizeMirror(parsed?.coreMirror),
		routerPort: sanitizePort(parsed?.routerPort, DEFAULT_ROUTER_PORT),
		mixedPort: sanitizePort(parsed?.mixedPort, DEFAULT_MIXED_PORT),
		clashPort: sanitizePort(parsed?.clashPort, DEFAULT_CLASH_PORT),
		routes,
		nodes
	}
}

/** Mint a fresh node id; the id doubles as the sing-box outbound tag. */
export function mintNodeId() {
	return `n_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/**
 * Build the state handle.
 * @param file - absolute path of the JSON document.
 * @param logger - logger used for non-fatal persistence diagnostics.
 * @returns the store handle.
 */
export function createStore(file, logger) {
	let state = sanitizeState({})
	let loaded = false
	let pending = Promise.resolve()

	async function load() {
		if (loaded) return state
		try {
			state = sanitizeState(JSON.parse(await readFile(file, 'utf8')))
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				logger.warn?.(`[dsh-net-proxy] ignoring unreadable state at ${file}: ${String(error)}`)
			}
		}
		loaded = true
		return state
	}

	async function persist() {
		await mkdir(dirname(file), { recursive: true })
		const temporary = `${file}.${process.pid}.tmp`
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
		await rename(temporary, file)
	}

	/** Run one mutation under the write lock and persist its result. */
	function mutate(action) {
		const run = pending.then(async () => {
			await load()
			const outcome = action(state)
			await persist()
			return outcome
		})
		// Keep the chain alive after a rejection so one failed write cannot wedge the store.
		pending = run.then(
			() => undefined,
			() => undefined
		)
		return run
	}

	return {
		file,
		load,
		state() {
			return state
		},
		nodes() {
			return state.nodes
		},
		node(id) {
			return state.nodes.find((node) => node.id === id)
		},
		settings() {
			const { mode, selectedId, injectShellEnv, coreMirror, routerPort, mixedPort, clashPort, routes } = state
			return { mode, selectedId, injectShellEnv, coreMirror, routerPort, mixedPort, clashPort, routes: [...routes] }
		},
		addNodes(records) {
			return mutate((current) => {
				const added = []
				const skipped = []
				for (const record of records) {
					const existing = current.nodes.find((node) => node.link === record.link)
					if (existing !== undefined) {
						skipped.push({ ...existing })
						continue
					}
					if (current.nodes.length >= MAX_NODES) {
						skipped.push({ ...record, id: '', duplicate: false, full: true })
						continue
					}
					const node = {
						id: mintNodeId(),
						remark: String(record.remark ?? '').trim().slice(0, MAX_REMARK),
						link: record.link,
						protocol: record.protocol,
						server: record.server,
						port: record.port,
						addedAt: new Date().toISOString(),
						lastTest: null
					}
					current.nodes.push(node)
					added.push({ ...node })
				}
				return { added, skipped }
			})
		},
		updateRemark(id, remark) {
			return mutate((current) => {
				const node = current.nodes.find((entry) => entry.id === id)
				if (node === undefined) return false
				node.remark = String(remark ?? '').trim().slice(0, MAX_REMARK)
				return true
			})
		},
		remove(ids) {
			return mutate((current) => {
				const wanted = new Set(Array.isArray(ids) ? ids : [ids])
				const before = current.nodes.length
				current.nodes = current.nodes.filter((node) => !wanted.has(node.id))
				if (current.selectedId !== null && wanted.has(current.selectedId)) current.selectedId = null
				return before - current.nodes.length
			})
		},
		recordTest(id, result) {
			return mutate((current) => {
				const node = current.nodes.find((entry) => entry.id === id)
				if (node === undefined) return false
				node.lastTest = {
					at: new Date().toISOString(),
					ok: result.ok === true,
					ms: Number.isFinite(result.ms) ? Number(result.ms) : null,
					error: typeof result.error === 'string' && result.error !== '' ? result.error : null,
					local: result.local === true
				}
				return true
			})
		},
		select(id) {
			return mutate((current) => {
				if (id === null) {
					current.selectedId = null
					return true
				}
				if (!current.nodes.some((node) => node.id === id)) return false
				current.selectedId = id
				return true
			})
		},
		setMode(mode) {
			return mutate((current) => {
				if (!MODES.includes(mode)) return false
				current.mode = mode
				return true
			})
		},
		setSettings(patch) {
			return mutate((current) => {
				if (typeof patch.injectShellEnv === 'boolean') current.injectShellEnv = patch.injectShellEnv
				if (patch.coreMirror !== undefined) current.coreMirror = sanitizeMirror(patch.coreMirror)
				if (Array.isArray(patch.routes)) {
					const routes = []
					for (const entry of patch.routes) {
						const route = normalizeRoute(entry)
						if (route === '' || routes.includes(route)) continue
						routes.push(route)
						if (routes.length >= MAX_ROUTES) break
					}
					current.routes = routes
				}
				if (patch.routerPort !== undefined) current.routerPort = sanitizePort(patch.routerPort, current.routerPort)
				if (patch.mixedPort !== undefined) current.mixedPort = sanitizePort(patch.mixedPort, current.mixedPort)
				if (patch.clashPort !== undefined) current.clashPort = sanitizePort(patch.clashPort, current.clashPort)
				return true
			})
		}
	}
}
