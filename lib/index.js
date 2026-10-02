/**
 * dsh-egress-router — host half.
 *
 * Gives the harness a way out of a censored or broken network: a library of
 * imported proxy nodes (vless/vmess/trojan/ss share links, each with the user's
 * own remark), a bundled sing-box core that reaches them, and one loopback HTTP
 * proxy that decides per request whether traffic goes direct or through a node.
 *
 * Three consumers, one policy:
 *
 * - the `net_proxy` agent tool, so the model can list nodes by remark, fetch a
 *   blocked URL through one, and drop the ones that turned out dead;
 * - the shell environment (`http_proxy`/`https_proxy`), so `curl`, `git` and
 *   `pip` in the agent's terminal use the same selective router with no flags;
 * - the Settings panel, which imports links, edits remarks and switches modes.
 *
 * @module dsh-egress-router
 */

import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { createCore, coreBinaryPath, existingCoreBinary, discardPartialCore } from './core.js'
import { CORE, platformKey } from './core-manifest.js'
import { parseShareLink, isIpv6Literal, schemeOf } from './links.js'
import { createRouter } from './router.js'
import { MODES, createStore, defaultDataDir, normalizeRoute } from './store.js'
import { tunnelFetchFollowing } from './tunnel-fetch.js'

/** Cordis plugin name. */
export const name = 'dsh-net-proxy'

/** Tool name the model sees. */
const TOOL_NAME = 'net_proxy'

/** RPC method name; the client reaches it at `/api/<RPC_ENDPOINT>`. */
const RPC_ENDPOINT = 'dsh-egress-router'

/** Proxy environment names this plugin owns while shell injection is on. */
const PROXY_ENV_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']
/** Bypass list that keeps loopback and the harness's own ports out of the router. */
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1,[::1]'
/** Longest link text accepted from one import call. */
const MAX_IMPORT_CHARS = 200_000

/** Report a rejected request in the shape the DSH client RPC layer expects. */
function failure(code, message) {
	return { ok: false, error: { code, message, details: {} } }
}

/** Wrap one RPC result in the envelope the DSH connection layer validates. */
function reply(rpcId, result) {
	const value =
		result.ok === false ? { ...result, error: { ...result.error, details: result.error.details ?? {} } } : result
	return Response.json({ type: 'server-response', rpcId, result: value })
}

/** Short human description of a node, used in every model-facing message. */
function label(node) {
	const remark = node.remark === '' ? '(未命名)' : node.remark
	return `${remark} [${node.id} · ${node.protocol} · ${node.server}:${node.port}]`
}

/**
 * True when a node's last test failed for a reason that belongs to this machine
 * rather than to the node. Such a node keeps its remark and is retried freely on
 * a machine that can reach it (for example one with IPv6 egress).
 */
function isLocallyBlocked(node) {
	return node.lastTest?.ok === false && node.lastTest.local === true
}

/** True when a node is known to be bad (a real failure, not a local limitation). */
function isKnownBad(node) {
	return node.lastTest?.ok === false && node.lastTest.local !== true
}

/** True when a failure says "this machine cannot try that node", not "the node is dead". */
export function isLocalLimitation(message) {
	return /没有 IPv6 出口|ENETUNREACH|EAFNOSUPPORT|EADDRNOTAVAIL|本地代理端口/.test(String(message ?? ''))
}

/**
 * Turn a raw transport failure into something a user can act on. The Clash API
 * answers a failed delay test with one fixed sentence and nothing else, and a
 * dead tunnel surfaces as the socket-level "hang up", so both need translating.
 */
function explainFailure(message) {
	const text = String(message ?? '')
	if (/An error occurred in the delay test/i.test(text)) return '测速失败：内核在超时时间内没能通过这个节点完成握手'
	if (/socket hang up|ECONNRESET|EPIPE/i.test(text)) return '连接被重置：节点可能已失效或被阻断'
	if (/^timeout$/i.test(text.trim()) || /ETIMEDOUT|timed out|超时/i.test(text)) return '连接超时：节点没有响应'
	return text
}

/** True when this machine has a globally routable IPv6 address. */
function hasGlobalIpv6() {
	const interfaces = networkInterfaces()
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			if (entry.family !== 'IPv6' || entry.internal) continue
			const address = entry.address.toLowerCase()
			if (address.startsWith('fe80') || address.startsWith('::1')) continue
			return true
		}
	}
	return false
}

/** Minimal text rendering for the tool's canonical values. */
function text(value) {
	return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * Register the node library, the core, the selective router, the RPC endpoint
 * the Settings panel calls, and the `net_proxy` tool.
 * @param ctx - the plugin context.
 * @param config - optional `dataDir` override.
 */
export function apply(ctx, config = {}) {
	const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-net-proxy') : (ctx.logger ?? console)
	const dataDir = config.dataDir === undefined ? defaultDataDir() : String(config.dataDir)
	const store = createStore(join(dataDir, 'state.json'), logger)
	const core = createCore({ dataDir, logger })
	const router = createRouter({
		logger,
		getPolicy: () => {
			const settings = store.settings()
			return {
				mode: settings.mode,
				routes: settings.routes,
				mixedPort: settings.mixedPort,
				coreRunning: core.running
			}
		}
	})

	/** Serializes every change that touches the core or the router. */
	let queue = Promise.resolve()
	/** Environment values this plugin overwrote, so unloading can restore them. */
	let savedEnv
	/** Cached "does this machine have IPv6" answer. */
	let ipv6Cache = { at: 0, value: false }
	/** Why the local proxy could not bind, when it could not. */
	let routerError = null

	function localIpv6() {
		if (Date.now() - ipv6Cache.at > 60_000) ipv6Cache = { at: Date.now(), value: hasGlobalIpv6() }
		return ipv6Cache.value
	}

	/** Run one critical section, keeping the chain alive after a rejection. */
	function exclusive(action) {
		const run = queue.then(action)
		queue = run.then(
			() => undefined,
			() => undefined
		)
		return run
	}

	/** Parse every stored link into the shape the core needs, skipping broken ones. */
	function nodeShapes() {
		const shapes = []
		for (const node of store.nodes()) {
			try {
				const parsed = parseShareLink(node.link)
				shapes.push({ tag: node.id, node, outbound: parsed.outbound })
			} catch (error) {
				logger.warn?.(`[dsh-net-proxy] 跳过无法解析的节点 ${node.id}：${String(error.message ?? error)}`)
			}
		}
		return shapes
	}

	/**
	 * The node a fresh request should try first: the manual choice when this
	 * machine can use it, then the fastest node known to work, then any untested
	 * node. Neither a node marked 失效 nor one this machine cannot reach (no IPv6
	 * egress, for example) is picked while anything usable is left.
	 */
	function preferredTag(shapes) {
		const selectedId = store.settings().selectedId
		const selected = shapes.find((shape) => shape.tag === selectedId)
		const usable = shapes.filter((shape) => !isKnownBad(shape.node) && !isLocallyBlocked(shape.node))
		const pool = usable.length > 0 ? usable : shapes.filter((shape) => !isKnownBad(shape.node))
		const candidates = pool.length > 0 ? pool : shapes
		if (selected !== undefined && candidates.includes(selected)) return selectedId
		const measured = candidates
			.filter((shape) => shape.node.lastTest?.ok === true)
			.sort((left, right) => (left.node.lastTest.ms ?? 1e9) - (right.node.lastTest.ms ?? 1e9))
		if (measured.length > 0) return measured[0].tag
		const untested = candidates.find((shape) => shape.node.lastTest === null || shape.node.lastTest === undefined)
		return (untested ?? candidates[0])?.tag
	}

	/** Sort candidates: healthy and fast first, then unmeasured, then failed. */
	function orderedShapes(shapes, target) {
		const scored = shapes.map((shape) => {
			const test = shape.node.lastTest
			// 0 = known good, 1 = never tested or blocked locally, 2 = known bad.
			const score = test === null || test === undefined ? 1 : test.ok ? 0 : isLocallyBlocked(shape.node) ? 1 : 2
			return { shape, score, ms: test?.ms ?? Number.MAX_SAFE_INTEGER }
		})
		scored.sort((left, right) => left.score - right.score || left.ms - right.ms)
		const ordered = scored.map((entry) => entry.shape)
		if (target === undefined || target === null || target === '') return ordered
		const needle = String(target).trim().toLowerCase()
		const matching = ordered.filter(
			(shape) =>
				shape.tag.toLowerCase() === needle ||
				shape.node.remark.toLowerCase().includes(needle) ||
				`${shape.node.server}:${shape.node.port}`.toLowerCase().includes(needle)
		)
		if (matching.length === 0) throw new Error(`没有找到匹配「${target}」的节点`)
		return matching
	}

	/**
	 * The order one automatic call tries nodes in: nodes not marked 失效 first, in
	 * health order. Nodes this machine cannot reach are skipped too, so an IPv6
	 * node on an IPv4-only host never costs a wasted attempt. When nothing is left
	 * the skipped ones are tried anyway — refusing outright would make a recovered
	 * node unreachable until the user re-tests it by hand.
	 * @returns `{ candidates, allFailed }`.
	 */
	function candidateOrder(shapes, target) {
		const ordered = orderedShapes(shapes, target)
		if (target !== undefined && target !== null && target !== '') return { candidates: ordered, allFailed: false }
		const viable = ordered.filter((shape) => !isKnownBad(shape.node) && !isLocallyBlocked(shape.node))
		if (viable.length > 0) return { candidates: viable, allFailed: false }
		const salvageable = ordered.filter((shape) => !isKnownBad(shape.node))
		if (salvageable.length > 0) return { candidates: salvageable, allFailed: false }
		return { candidates: ordered, allFailed: ordered.length > 0 }
	}

	/** Push the current library into the core and the router. */
	async function applyPolicy() {
		const settings = store.settings()
		const shapes = nodeShapes()
		const selectedTag = preferredTag(shapes)
		const coreState = await core.sync({
			nodes: shapes,
			mixedPort: settings.mixedPort,
			clashPort: settings.clashPort,
			pinnedTag: settings.selectedId
		})
		if (coreState.running && selectedTag !== undefined) {
			try {
				await core.select(selectedTag)
			} catch (error) {
				logger.debug?.(`[dsh-net-proxy] 选中节点失败：${String(error.message ?? error)}`)
			}
		}
		if (router.port !== settings.routerPort) {
			try {
				await router.start(settings.routerPort)
				routerError = null
			} catch (error) {
				routerError = `本地代理端口 ${settings.routerPort} 启动失败：${String(error.message ?? error)}`
				logger.warn?.(`[dsh-net-proxy] ${routerError}`)
			}
		}
		applyShellEnv()
	}

	/** Write (or restore) the proxy environment the agent's shell inherits. */
	function applyShellEnv() {
		const settings = store.settings()
		const wanted = settings.injectShellEnv && settings.mode !== 'off'
		if (savedEnv === undefined) {
			savedEnv = {}
			for (const key of [...PROXY_ENV_NAMES, 'no_proxy', 'NO_PROXY']) savedEnv[key] = process.env[key]
		}
		if (wanted) {
			const url = `http://127.0.0.1:${router.port || settings.routerPort}`
			for (const key of PROXY_ENV_NAMES) process.env[key] = url
			process.env.no_proxy = LOOPBACK_NO_PROXY
			process.env.NO_PROXY = LOOPBACK_NO_PROXY
			return
		}
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}

	/** The public shape of one node. */
	function publicNode(node) {
		return {
			id: node.id,
			remark: node.remark,
			protocol: node.protocol,
			server: node.server,
			port: node.port,
			link: node.link,
			addedAt: node.addedAt,
			// A bare IPv6 literal address: the panel flags these only when this
			// machine has no IPv6 egress, so a deployment that never meets one
			// never shows an IPv6 warning.
			ipv6Only: isIpv6Literal(node.server),
			lastTest: node.lastTest,
			status: node.lastTest === null ? 'unknown' : node.lastTest.ok ? 'ok' : isLocallyBlocked(node) ? 'blocked' : 'fail'
		}
	}

	/** The release asset this platform needs, or `null` when there is none. */
	function coreAssetName() {
		const key = platformKey()
		return key === undefined ? null : (CORE.assets[key]?.name ?? null)
	}

	/** Where the core would be downloaded from, honouring the configured mirror. */
	function coreDownloadUrl() {
		const asset = coreAssetName()
		if (asset === null) return null
		const base = (store.settings().coreMirror || CORE.releaseBase).replace(/\/+$/, '')
		return `${base}/${asset}`
	}

	/** Everything the Settings panel and the tool report. */
	function snapshot() {
		const settings = store.settings()
		return {
			...settings,
			proxyUrl: `http://127.0.0.1:${settings.routerPort}`,
			core: {
				running: core.running,
				version: core.version,
				error: core.lastError,
				configFile: core.configFile,
				binary: core.binary,
				installed: core.installed,
				expectedBinary: coreBinaryPath(dataDir),
				platform: platformKey() ?? `${process.platform}/${process.arch}`,
				asset: coreAssetName(),
				coreVersion: CORE.version,
				downloadUrl: coreDownloadUrl(),
				mirror: settings.coreMirror
			},
			localIpv6: localIpv6(),
			nodes: store.nodes().map(publicNode),
			dataFile: store.file,
			router: { port: router.port, error: routerError, stats: router.stats, sticky: router.sticky, recent: router.recent }
		}
	}

	/** Import pasted links, returning what landed and what was rejected. */
	async function importLinks(text, remarkPrefix) {
		const lines = String(text ?? '')
			.slice(0, MAX_IMPORT_CHARS)
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
		if (lines.length === 0) throw new Error('没有可导入的链接')
		const records = []
		const errors = []
		lines.forEach((line, index) => {
			if (schemeOf(line) === undefined && /^https?:\/\//i.test(line)) {
				// A subscription URL is a different feature; say so instead of "unknown scheme".
				errors.push({ line: index + 1, message: '这是订阅链接（http/https），本插件只支持直接粘贴节点分享链接' })
				return
			}
			try {
				const parsed = parseShareLink(line)
				const prefix = typeof remarkPrefix === 'string' ? remarkPrefix.trim() : ''
				records.push({
					link: line,
					protocol: parsed.protocol,
					server: parsed.server,
					port: parsed.port,
					remark: parsed.remark === '' ? prefix : prefix === '' ? parsed.remark : `${prefix} ${parsed.remark}`
				})
			} catch (error) {
				errors.push({ line: index + 1, message: String(error.message ?? error) })
			}
		})
		const outcome = records.length === 0 ? { added: [], skipped: [] } : await store.addNodes(records)
		return {
			imported: outcome.added.map((node) => ({
				id: node.id,
				remark: node.remark,
				protocol: node.protocol,
				server: node.server,
				port: node.port
			})),
			duplicates: outcome.skipped.map((node) => ({ id: node.id, remark: node.remark })),
			errors
		}
	}

	/** Measure one node, recording the result. Never throws. */
	async function testNode(shape, options = {}) {
		const node = shape.node
		const base = { id: node.id, remark: node.remark, protocol: node.protocol, server: `${node.server}:${node.port}` }
		if (isIpv6Literal(node.server) && !localIpv6()) {
			const message = '本机没有 IPv6 出口，无法测试这条 IPv6 节点'
			await store.recordTest(node.id, { ok: false, ms: null, error: message, local: true })
			return { ...base, ok: false, ms: null, error: message, localLimitation: true }
		}
		try {
			const ms = await core.measure(shape.tag, { url: options.url, timeoutMs: options.timeoutMs ?? 6000 })
			await store.recordTest(node.id, { ok: true, ms, error: null })
			return { ...base, ok: true, ms, error: null, localLimitation: false }
		} catch (error) {
			const message = explainFailure(error.message ?? error)
			const local = isLocalLimitation(message)
			await store.recordTest(node.id, { ok: false, ms: null, error: message, local })
			return { ...base, ok: false, ms: null, error: message, localLimitation: local }
		}
	}

	/**
	 * Decide whether a node is really dead before dropping it.
	 *
	 * One failed URL only proves that *request* failed — the site could be the
	 * problem, not the node. So ask the core for a plain handshake test first: a
	 * node that cannot be measured at all is dead; one that measures fine is kept
	 * and the failure is reported as the site's.
	 * @returns `{ dead, ms, error }`.
	 */
	async function confirmDead(shape) {
		try {
			const ms = await core.measure(shape.tag, { timeoutMs: 5000 })
			await store.recordTest(shape.node.id, { ok: true, ms, error: null })
			return { dead: false, ms, error: null }
		} catch (error) {
			const message = explainFailure(error.message ?? error)
			const local = isLocalLimitation(message)
			await store.recordTest(shape.node.id, { ok: false, ms: null, error: message, local })
			return { dead: !local, ms: null, error: message, local }
		}
	}

	/**
	 * Fetch a URL through the core, trying nodes in order.
	 *
	 * A failing node is never deleted: it loses its 正常 status, keeps its remark
	 * and record, and later automatic calls skip it. The user removes a node only
	 * on purpose, from the panel or with `remove`.
	 */
	async function fetchThroughNodes(url, options = {}) {
		const shapes = nodeShapes()
		if (shapes.length === 0) throw new Error('还没有导入任何节点，先在 设置 → 网络代理 里粘贴分享链接')
		if (!core.running) {
			await applyPolicy()
			if (!core.running) throw new Error(`内核未运行：${core.lastError ?? '原因未知'}`)
		}
		const explicit = options.target === undefined || options.target === null || options.target === ''
		const { candidates, allFailed } = candidateOrder(shapes, explicit ? undefined : options.target)
		if (explicit) {
			// Honour the manual choice first, then fall back to the health order.
			const chosen = store.settings().selectedId
			const index = chosen === null ? -1 : candidates.findIndex((shape) => shape.tag === chosen)
			if (index > 0) candidates.unshift(...candidates.splice(index, 1))
		}
		const attempts = []
		const marked = []
		for (const shape of candidates) {
			const node = shape.node
			const started = Date.now()
			if (isIpv6Literal(node.server) && !localIpv6()) {
				const message = '本机没有 IPv6 出口，跳过'
				await store.recordTest(node.id, { ok: false, ms: null, error: message, local: true })
				attempts.push({ node: label(node), ok: false, ms: null, error: message })
				continue
			}
			try {
				await core.select(shape.tag)
				const response = await tunnelFetchFollowing(url, {
					mixedPort: store.settings().mixedPort,
					method: options.method ?? 'GET',
					headers: options.headers,
					body: options.body,
					timeoutMs: options.timeoutMs ?? 20_000,
					maxBytes: options.maxBytes ?? 60_000,
					signal: options.signal
				})
				const ms = Date.now() - started
				await store.recordTest(node.id, { ok: true, ms, error: null })
				return { response, node, attempts, marked, allFailed, ms }
			} catch (error) {
				const message = explainFailure(error.message ?? error)
				if (options.signal?.aborted) throw new Error('请求已取消')
				let note = message
				if (isLocalLimitation(message)) {
					await store.recordTest(node.id, { ok: false, ms: null, error: message, local: true })
					note = `${message}（本机限制，节点状态不受影响）`
				} else {
					// One failed URL does not prove the node is dead, so confirm with a
					// plain handshake test before changing what later calls avoid.
					const verdict = await confirmDead(shape)
					if (verdict.dead) {
						marked.push(label(node))
						note = `${message}；复测仍然失败，已标记为「失效」，之后的调用会自动避开它（节点不会被删除）`
					} else {
						note = `${message}（复测该节点正常 ${verdict.ms}ms，判定是目标站点的问题，节点保持正常）`
					}
				}
				attempts.push({ node: label(node), ok: false, ms: Date.now() - started, error: note })
			}
		}
		return { response: undefined, node: undefined, attempts, marked, allFailed, ms: null }
	}

	/** Decode a response body for the model: text when it looks textual, else a note. */
	function decodeBody(response) {
		const contentType = String(response.headers['content-type'] ?? '')
		const textual =
			contentType === '' ||
			/text|json|xml|javascript|urlencoded|yaml|csv|html/i.test(contentType) ||
			!/[\u0000-\u0008\u000e-\u001f]/.test(response.body.subarray(0, 512).toString('latin1'))
		if (textual) return { body: response.body.toString('utf8'), encoding: 'utf8' }
		return { body: response.body.toString('base64'), encoding: 'base64' }
	}

	/** Build the canonical value for one tool call. */
	async function runTool(args, exec) {
		const action = String(args?.action ?? '').trim()
		const settings = () => store.settings()
		switch (action) {
			case 'status': {
				await store.load()
				return {
					ok: true,
					mode: settings().mode,
					selected: selectedDescription(),
					proxyUrl: `http://127.0.0.1:${settings().routerPort}`,
					core: { running: core.running, version: core.version, error: core.lastError },
					localIpv6: localIpv6(),
					nodeCount: store.nodes().length,
					routes: settings().routes,
					shellEnvInjected: process.env.HTTPS_PROXY?.includes(`:${settings().routerPort}`) === true,
					recent: router.recent.slice(0, 8)
				}
			}
			case 'list': {
				await store.load()
				return {
					ok: true,
					mode: settings().mode,
					selected: selectedDescription(),
					proxyUrl: `http://127.0.0.1:${settings().routerPort}`,
					nodes: store.nodes().map((node) => ({
						...publicNode(node),
						link: `${node.link.slice(0, 48)}…`
					})),
					routes: settings().routes
				}
			}
			case 'import': {
				const outcome = await importLinks(args.links, args.remark)
				await exclusive(applyPolicy)
				return { ok: true, ...outcome, nodeCount: store.nodes().length }
			}
			case 'remove': {
				const removed = await exclusive(async () => {
					const shapes = orderedShapes(nodeShapes(), args.target ?? args.id)
					const ids = shapes.map((shape) => shape.tag)
					const count = await store.remove(ids)
					await applyPolicy()
					return { count, labels: shapes.map((shape) => label(shape.node)) }
				})
				return { ok: true, removed: removed.count, removedNodes: removed.labels, nodeCount: store.nodes().length }
			}
			case 'use': {
				const target = String(args.target ?? '').trim()
				if (target === '' || target.toLowerCase() === 'auto') {
					await store.select(null)
					await exclusive(applyPolicy)
					return { ok: true, message: `已改为自动选择（当前：${selectedDescription()}）` }
				}
				const shape = orderedShapes(nodeShapes(), target)[0]
				await store.select(shape.tag)
				await exclusive(applyPolicy)
				return { ok: true, message: `已选用 ${label(shape.node)}`, selected: selectedDescription() }
			}
			case 'mode': {
				const mode = String(args.mode ?? '').trim()
				if (!MODES.includes(mode)) throw new Error(`mode 只能是 ${MODES.join(' / ')}`)
				await store.setMode(mode)
				await exclusive(applyPolicy)
				return { ok: true, mode, message: `代理模式已切换为 ${mode}` }
			}
			case 'route': {
				const current = settings().routes
				const add = Array.isArray(args.hosts) ? args.hosts.map(normalizeRoute).filter((entry) => entry !== '') : []
				const drop = Array.isArray(args.delete_hosts)
					? args.delete_hosts.map(normalizeRoute).filter((entry) => entry !== '')
					: []
				const next = [...current.filter((entry) => !drop.includes(entry)), ...add.filter((entry) => !current.includes(entry))]
				await store.setSettings({ routes: next })
				await exclusive(applyPolicy)
				return { ok: true, routes: next, message: `路由名单已更新（${next.length} 条）` }
			}
			case 'test': {
				await store.load()
				const shapes = args.id === undefined && args.target === undefined ? nodeShapes() : orderedShapes(nodeShapes(), args.id ?? args.target)
				const results = []
				for (const shape of shapes) results.push(await testNode(shape, { url: args.test_url, timeoutMs: args.timeoutMs }))
				// Testing only writes status; deleting stays an explicit request.
				const deleted = []
				if (args.delete_dead === true) {
					const dead = results.filter((result) => !result.ok && result.localLimitation !== true).map((result) => result.id)
					if (dead.length > 0) {
						await store.remove(dead)
						deleted.push(...results.filter((result) => dead.includes(result.id)).map((result) => result.remark || result.id))
					}
				}
				await exclusive(applyPolicy)
				return {
					ok: true,
					results,
					deleted,
					failed: results.filter((result) => !result.ok && result.localLimitation !== true).map((result) => result.remark || result.id),
					nodeCount: store.nodes().length
				}
			}
			case 'clean': {
				await store.load()
				const dead = store.nodes().filter(isKnownBad).map((node) => node.id)
				const labels = store.nodes().filter((node) => dead.includes(node.id)).map((node) => label(node))
				const removed = dead.length === 0 ? 0 : await store.remove(dead)
				await exclusive(applyPolicy)
				return { ok: true, removed, removedNodes: labels, nodeCount: store.nodes().length }
			}
			case 'core': {
				await store.load()
				if (!(await core.installed)) {
					try {
						const installed = await exclusive(async () => {
							await discardPartialCore(dataDir)
							const result = await core.install({ mirror: store.settings().coreMirror })
							await applyPolicy()
							return result
						})
						return {
							ok: true,
							installed: true,
							source: installed.source,
							asset: installed.asset,
							path: installed.path,
							version: installed.version,
							message: `内核已就绪（sing-box ${installed.version}）`
						}
					} catch (error) {
						return {
							ok: false,
							installed: false,
							platform: platformKey() ?? `${process.platform}/${process.arch}`,
							downloadUrl: coreDownloadUrl(),
							expectedPath: coreBinaryPath(dataDir),
							message: `内核下载失败：${String(error.message ?? error)}`
						}
					}
				}
				return {
					ok: true,
					installed: true,
					binary: core.binary,
					version: core.version,
					running: core.running,
					message: `内核已就绪（sing-box ${core.version ?? CORE.version}，运行中：${core.running ? '是' : '否'}）`
				}
			}
			case 'fetch': {
				const url = String(args.url ?? '').trim()
				if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http:// 或 https:// 开头的绝对地址')
				await store.load()
				const outcome = await fetchThroughNodes(url, {
					target: args.target ?? args.id,
					method: args.method,
					headers: args.headers,
					body: args.body,
					timeoutMs: args.timeoutMs,
					maxBytes: args.maxBytes,
					signal: exec?.signal
				})
				if (outcome.response === undefined) {
					return {
						ok: false,
						url,
						attempts: outcome.attempts,
						marked: outcome.marked,
						allFailed: outcome.allFailed,
						message: outcome.allFailed ? '所有节点都处于「失效」状态，已按顺序重试但都没成功' : '所有候选节点都没能取回内容'
					}
				}
				const decoded = decodeBody(outcome.response)
				return {
					ok: true,
					url: outcome.response.url,
					status: outcome.response.status,
					headers: outcome.response.headers,
					node: { id: outcome.node.id, remark: outcome.node.remark },
					elapsedMs: outcome.ms,
					truncated: outcome.response.truncated,
					encoding: decoded.encoding,
					body: decoded.body,
					attempts: outcome.attempts,
					marked: outcome.marked
				}
			}
			default:
				throw new Error(
					`未知 action「${action}」，可用：status / list / import / remove / use / mode / route / test / clean / fetch`
				)
		}
	}

	/** One-line description of the effective node choice. */
	function selectedDescription() {
		const shapes = nodeShapes()
		if (shapes.length === 0) return '无节点'
		const tag = preferredTag(shapes)
		const shape = shapes.find((entry) => entry.tag === tag)
		if (shape === undefined) return '无节点'
		const mode = store.settings().selectedId === null ? '自动' : '手动'
		return `${mode} · ${label(shape.node)}`
	}

	/** Render one tool value as the text the model reads. */
	function renderToolValue(value) {
		/** One line per node whose status changed to 失效 during this call. */
		const markedLines = (marked) => ((marked ?? []).length === 0 ? [] : [`已标记为失效（不会再被自动调用，节点保留）：${marked.join('；')}`])
		if (value.ok === false && value.message !== undefined) {
			const lines = [`失败：${value.message}`, `URL: ${value.url ?? '(未提供)'}`]
			for (const attempt of value.attempts ?? []) lines.push(`  ✗ ${attempt.node}: ${attempt.error}`)
			lines.push(...markedLines(value.marked))
			if (value.allFailed === true) lines.push('提示：可以 action=test 重新测试，或 action=use 手动指定节点。')
			return lines.join('\n')
		}
		if (value.body !== undefined) {
			const lines = [
				`HTTP ${value.status} · ${value.elapsedMs}ms · 节点「${value.node.remark || value.node.id}」`,
				`URL: ${value.url}`,
				`Content-Type: ${value.headers?.['content-type'] ?? '(无)'}${value.truncated ? ' · 内容已截断' : ''}${value.encoding === 'base64' ? ' · base64' : ''}`
			]
			for (const attempt of value.attempts ?? []) lines.push(`  ✗ 先失败：${attempt.node} —— ${attempt.error}`)
			lines.push(...markedLines(value.marked))
			lines.push('', value.body)
			return lines.join('\n')
		}
		if (value.installed !== undefined) {
			const lines = [value.message]
			if (value.ok === false) {
				if (value.platform !== undefined) lines.push(`本平台：${value.platform}`)
				if (value.downloadUrl !== null && value.downloadUrl !== undefined) lines.push(`可手动下载：${value.downloadUrl}`)
				if (value.expectedPath !== undefined) lines.push(`放到这个路径即可被识别：${value.expectedPath}`)
			}
			return lines.join('\n')
		}
		if (value.removedNodes !== undefined) {
			if ((value.removedNodes ?? []).length === 0) return `没有需要处理的节点（当前共 ${value.nodeCount ?? '?'} 个）。`
			return [`已删除 ${value.removed} 个节点：`, ...value.removedNodes.map((entry) => `  ✗ ${entry}`)].join('\n')
		}
		if (typeof value.message === 'string' && value.ok === true) {
			return [value.message, ...(Array.isArray(value.routes) ? [`当前名单（${value.routes.length} 条）：${value.routes.join('、')}`] : [])].join('\n')
		}
		if (value.nodes !== undefined && Array.isArray(value.nodes)) {
			const lines = [`模式 ${value.mode} · 当前 ${value.selected} · 共 ${value.nodes.length} 个节点`]
			for (const node of value.nodes) {
				const test = node.lastTest
				const state =
					node.status === 'ok'
						? `正常 ${test?.ms ?? '?'}ms`
						: node.status === 'fail'
							? `失效：${test?.error ?? ''}`
							: node.status === 'blocked'
								? `本机不可用：${test?.error ?? ''}`
								: '未测试'
				lines.push(`- ${node.id} · ${node.remark || '(未命名)'} · ${node.protocol} ${node.server}:${node.port} · ${state}`)
			}
			return lines.join('\n')
		}
		if (value.results !== undefined) {
			const lines = ['节点测试结果：']
			for (const result of value.results) {
				lines.push(
					`- ${result.remark || result.id} · ${result.server} · ${result.ok ? `正常 ${result.ms}ms` : `失效：${result.error}${result.localLimitation ? '（本机限制，未改变状态判定）' : ''}`}`
				)
			}
			if ((value.failed ?? []).length > 0) lines.push(`已标记为失效：${value.failed.join('；')}（自动调用会避开，节点保留）`)
			if ((value.deleted ?? []).length > 0) lines.push(`已删除：${value.deleted.join('；')}`)
			return lines.join('\n')
		}
		if (value.imported !== undefined) {
			const lines = [`导入完成：新增 ${value.imported.length} 个，重复跳过 ${value.duplicates?.length ?? 0} 个，失败 ${value.errors?.length ?? 0} 个`]
			for (const node of value.imported) lines.push(`  ✓ ${node.remark || '(未命名)'} · ${node.protocol} ${node.server}:${node.port} · ${node.id}`)
			for (const error of value.errors ?? []) lines.push(`  ✗ 第 ${error.line} 行：${error.message}`)
			return lines.join('\n')
		}
		return JSON.stringify(value, null, 2)
	}

	// ── lifecycle ────────────────────────────────────────────────────────────
	ctx.effect(() => {
		store
			.load()
			.then(() => exclusive(applyPolicy))
			.catch((error) => logger.warn?.(`[dsh-net-proxy] 初始化失败：${String(error)}`))
		return () => {
			applyShellEnvRestore()
		}
	}, 'dsh-net-proxy: start policy and restore the environment on unload')

	/** Restore the shell environment this plugin overwrote. */
	function applyShellEnvRestore() {
		if (savedEnv === undefined) return
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		savedEnv = undefined
	}

	ctx.effect(
		() => () => {
			applyShellEnvRestore()
			router.stop().catch(() => {})
			core.dispose().catch(() => {})
		},
		'dsh-net-proxy: stop the router and the core'
	)

	// ── the Settings panel's RPC endpoint ────────────────────────────────────
	async function handle(method, payload) {
		await store.load()
		switch (method) {
			case 'list':
				return { ok: true, value: snapshot() }
			case 'import': {
				const outcome = await importLinks(payload?.links, payload?.remark)
				await exclusive(applyPolicy)
				return { ok: true, value: { ...snapshot(), ...outcome } }
			}
			case 'update': {
				const id = String(payload?.id ?? '')
				const remark = String(payload?.remark ?? '')
				const updated = await store.updateRemark(id, remark)
				if (!updated) return failure('net-proxy/not-found', '这个节点已经不存在了。')
				return { ok: true, value: snapshot() }
			}
			case 'remove': {
				const removed = await exclusive(async () => {
					const count = await store.remove(String(payload?.id ?? ''))
					await applyPolicy()
					return count
				})
				if (removed === 0) return failure('net-proxy/not-found', '这个节点已经不存在了。')
				return { ok: true, value: snapshot() }
			}
			case 'select': {
				const id = payload?.id === null || payload?.id === undefined ? null : String(payload.id)
				const selected = await store.select(id)
				if (!selected) return failure('net-proxy/not-found', '这个节点已经不存在了。')
				await exclusive(applyPolicy)
				return { ok: true, value: snapshot() }
			}
			case 'setMode': {
				const mode = String(payload?.mode ?? '')
				if (!MODES.includes(mode)) return failure('net-proxy/bad-mode', `模式只能是 ${MODES.join(' / ')}。`)
				await store.setMode(mode)
				await exclusive(applyPolicy)
				return { ok: true, value: snapshot() }
			}
			case 'settings': {
				await store.setSettings({
					injectShellEnv: payload?.injectShellEnv,
					coreMirror: payload?.coreMirror,
					routes: payload?.routes,
					routerPort: payload?.routerPort,
					mixedPort: payload?.mixedPort,
					clashPort: payload?.clashPort
				})
				await exclusive(applyPolicy)
				return { ok: true, value: snapshot() }
			}
			case 'test': {
				const shapes =
					payload?.id === undefined || payload.id === null || payload.id === ''
						? nodeShapes()
						: orderedShapes(nodeShapes(), String(payload.id))
				const results = []
				for (const shape of shapes) results.push(await testNode(shape, {}))
				await exclusive(applyPolicy)
				return { ok: true, value: { ...snapshot(), results } }
			}
			case 'clean': {
				const dead = store.nodes().filter(isKnownBad).map((node) => node.id)
				const removed = dead.length === 0 ? 0 : await store.remove(dead)
				await exclusive(applyPolicy)
				return { ok: true, value: { ...snapshot(), removed } }
			}
			case 'installCore': {
				const result = await exclusive(async () => {
					await discardPartialCore(dataDir)
					const installed = await core.install({ mirror: store.settings().coreMirror })
					await applyPolicy()
					return installed
				})
				return { ok: true, value: { ...snapshot(), installed: { source: result.source, asset: result.asset, path: result.path } } }
			}
			case 'restart': {
				await exclusive(async () => {
					await core.stop()
					await applyPolicy()
				})
				return { ok: true, value: snapshot() }
			}
			default:
				return failure('net-proxy/unknown-method', `未知的网络代理接口：${String(method)}`)
		}
	}

	ctx.inject(['connection'], (rpc) => {
		rpc.effect(() => {
			if (typeof rpc.connection?.fetch?.register !== 'function') return () => {}
			const dispose = rpc.connection.fetch.register({
				path: `/api/${RPC_ENDPOINT}`,
				methods: ['POST'],
				requestBody: 'buffered',
				async fetch(request) {
					if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
					if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
						return new Response('content type must be application/json', { status: 415 })
					}
					let message
					try {
						message = await request.json()
					} catch {
						return new Response('body is not JSON', { status: 400 })
					}
					const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
					const call = message?.payload
					if (
						message === null ||
						typeof message !== 'object' ||
						message.type !== 'client-request' ||
						typeof message.rpcId !== 'string' ||
						message.method !== RPC_ENDPOINT ||
						call === null ||
						typeof call !== 'object' ||
						typeof call.method !== 'string' ||
						!Object.hasOwn(call, 'payload')
					) {
						return reply(rpcId, failure('net-proxy/bad-request', '网络代理请求格式无效。'))
					}
					try {
						return reply(rpcId, await handle(call.method, call.payload))
					} catch (error) {
						logger.error?.(`[dsh-net-proxy] ${call.method} 失败：${String(error)}`)
						return reply(rpcId, failure('net-proxy/failed', String(error.message ?? error)))
					}
				}
			})
			return () => dispose?.()
		}, 'dsh-net-proxy: settings rpc endpoint')
	}, 'dsh-net-proxy: optional settings rpc')

	// ── the agent-facing tool ────────────────────────────────────────────────
	ctx.inject(['tools'], (tools) => {
		tools.effect(
			() =>
				tools.tools.register({
					name: TOOL_NAME,
					description: [
						'本地网络代理（sing-box 内核 + 选择性路由）。当直连被阻断（例如 github.com 连接超时）时用它取回内容。',
						'本地 HTTP 代理地址固定为 http://127.0.0.1:<端口>（见下方 proxyUrl），也可直接在 bash 里 `curl -x http://127.0.0.1:30810 https://github.com`；',
						'Agent 的 shell 环境变量已按设置注入该代理，curl/git/pip 默认就会用它（智能模式下只有名单内站点走节点，其余直连）。',
						'action 说明：list=查看节点（含用户写的备注与状态）；fetch=通过节点抓取 URL（自动挑状态正常的节点逐个回退；某个节点反复失败只标记为失效并从此避开，绝不自动删除）；',
						'test=连通性测试（正常就标记为正常、失败就标记为失效）；clean=删除被标记失效的节点（只有这一步会删）；import=导入分享链接（vless/vmess/trojan/ss，多行）；',
						'use=选用节点（target 传 id 或备注关键字，传 auto 恢复自动）；mode=切换 off/auto/always；route=维护强制走代理的域名；core=检查并自动下载缺失的 sing-box 内核。'
					].join('\n'),
					parameters: {
						type: 'object',
						additionalProperties: false,
						required: ['action'],
						properties: {
							action: {
								type: 'string',
								enum: ['status', 'list', 'import', 'remove', 'use', 'mode', 'route', 'test', 'clean', 'fetch', 'core'],
								description: '要执行的操作'
							},
							url: { type: 'string', description: 'fetch 的目标地址（http/https 绝对地址）' },
							method: { type: 'string', description: 'fetch 的 HTTP 方法，默认 GET' },
							headers: {
								type: 'object',
								additionalProperties: { type: 'string' },
								description: 'fetch 的请求头'
							},
							body: { type: 'string', description: 'fetch 的请求体（字符串）' },
							maxBytes: { type: 'integer', description: 'fetch 返回正文的最大字节数，默认 60000' },
							timeoutMs: { type: 'integer', description: '本次操作的超时时间（毫秒）' },
							links: { type: 'string', description: 'import：一行一条分享链接，可多行' },
							remark: { type: 'string', description: 'import：给这批节点加的前缀备注；remove/use/test：节点 id 或备注关键字' },
							id: { type: 'string', description: '节点 id（remove/use/test 可用 remark 代替）' },
							target: { type: 'string', description: '节点 id 或备注关键字；fetch 时指定用哪个节点' },
							mode: { type: 'string', enum: ['off', 'auto', 'always'], description: 'mode：off=全部直连，auto=智能，always=全部走节点' },
							hosts: { type: 'array', items: { type: 'string' }, description: 'route：要加入强制走代理名单的域名' },
							delete_hosts: { type: 'array', items: { type: 'string' }, description: 'route：要从名单里移除的域名' },
							test_url: { type: 'string', description: 'test：用于测速的 URL，默认 https://cp.cloudflare.com/generate_204' },
							delete_dead: { type: 'boolean', description: 'test：为 true 时把测试失败的节点一并删除（默认 false，只标记失效）' }
						}
					},
					output: {
						schema: { type: 'object' },
						render: (_args, value) => text(renderToolValue(value))
					},
					async execute(args, exec) {
						await store.load()
						return runTool(args, exec)
					}
				}),
			'dsh-net-proxy: agent tool'
		)
	}, 'dsh-net-proxy: optional agent tool')
}
