/**
 * The sing-box core for dsh-egress-router.
 *
 * Owns exactly one child process: the bundled `sing-box` binary running a
 * generated config whose outbounds are the imported nodes, plus the Clash API
 * that lets us switch the active node and measure per-node latency without a
 * restart. The config file is rewritten and the process restarted only when the
 * *shape* changes (nodes, ports) — selecting a node is a Clash API call.
 *
 * @module dsh-egress-router/core
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { get as httpGet, request as httpRequest } from 'node:http'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE, coreFileName, platformKey } from './core-manifest.js'

/** A binary dropped into the plugin package by hand (development checkouts). */
export const BUNDLED_BINARY = fileURLToPath(new URL(`../bin/${coreFileName()}`, import.meta.url))

/** Where the plugin keeps a downloaded core: `$DSH_HOME/integrations/<name>/bin/sing-box`. */
export function coreBinaryPath(dataDir) {
	return join(dataDir, 'bin', coreFileName())
}

/** Every path a core may live at, most specific first. */
export function coreCandidatePaths({ dataDir, explicit }) {
	return [explicit, coreBinaryPath(dataDir), BUNDLED_BINARY].filter(
		(candidate) => typeof candidate === 'string' && candidate.length > 0
	)
}

/** The first candidate that actually exists, or `undefined`. */
export async function existingCoreBinary({ dataDir, explicit }) {
	for (const candidate of coreCandidatePaths({ dataDir, explicit })) {
		if (await isFile(candidate)) return candidate
	}
	return undefined
}

/** True when `path` is an existing file. */
async function isFile(path) {
	if (typeof path !== 'string' || path === '') return false
	try {
		return (await stat(path)).isFile()
	} catch {
		return false
	}
}

/** Follow redirects while downloading one file, verifying its SHA-256. */
function downloadFile(url, destination, { expectedSha, timeoutMs = 600_000 } = {}) {
	return new Promise((resolve, reject) => {
		const request = url.startsWith('https:') ? httpsGet : httpGet
		const hash = createHash('sha256')
		let settled = false
		const fail = (error) => {
			if (settled) return
			settled = true
			reject(error)
		}
		const visit = (target, hops) => {
			const req = request(target, (response) => {
				const status = response.statusCode ?? 0
				if ([301, 302, 303, 307, 308].includes(status) && typeof response.headers.location === 'string') {
					response.resume()
					if (hops <= 0) return fail(new Error('下载重定向次数过多'))
					return visit(new URL(response.headers.location, target).href, hops - 1)
				}
				if (status !== 200) {
					response.resume()
					return fail(new Error(`下载失败：HTTP ${status}（${target}）`))
				}
				const file = createWriteStream(destination, { mode: 0o755 })
				response.on('data', (chunk) => hash.update(chunk))
				response.pipe(file)
				file.on('error', fail)
				file.on('close', () => {
					if (settled) return
					const digest = hash.digest('hex')
					if (expectedSha !== undefined && digest !== expectedSha) {
						return fail(new Error(`校验失败：期望 ${expectedSha}，实际 ${digest}`))
					}
					settled = true
					resolve(digest)
				})
			})
			req.setTimeout(timeoutMs, () => req.destroy(new Error(`下载超时（${timeoutMs}ms）`)))
			req.on('error', fail)
		}
		visit(url, 5)
	})
}

/**
 * Make sure a usable core exists, downloading it from the pinned release when it
 * does not.
 *
 * A mirror prefix (any URL serving the same asset names) replaces the GitHub
 * release base, so a deployment whose GitHub access is blocked can point at a
 * proxy or a self-hosted copy of the same files.
 * @returns `{ path, source, asset, version }`.
 */
export async function ensureCoreBinary({ dataDir, explicit, logger, mirror, signal, onProgress }) {
	if (signal?.aborted) throw new Error('已取消')
	const present = await existingCoreBinary({ dataDir, explicit })
	if (present !== undefined) return { path: present, source: 'existing', asset: null, version: CORE.version }
	const key = platformKey()
	const asset = key === undefined ? undefined : CORE.assets[key]
	if (asset === undefined) {
		throw new Error(
			`本平台（${process.platform}/${process.arch}）没有预编译内核：请自行准备 sing-box 放到 ${coreBinaryPath(dataDir)}，或把 coreMirror 指向一个包含该平台内核的地址`
		)
	}
	const base = (typeof mirror === 'string' && mirror.trim() !== '' ? mirror.trim() : CORE.releaseBase).replace(/\/+$/, '')
	const directory = join(dataDir, 'bin')
	await mkdir(directory, { recursive: true })
	const target = coreBinaryPath(dataDir)
	onProgress?.(`正在下载内核 ${asset.name}（sing-box ${CORE.version}）…`)
	logger?.info?.(`[dsh-net-proxy] 下载内核：${base}/${asset.name}`)
	await downloadFile(`${base}/${asset.name}`, `${target}.part`, { expectedSha: asset.sha256 })
	await rename(`${target}.part`, target)
	await chmod(target, 0o755)
	if (asset.extra !== undefined) {
		const extraTarget = join(directory, asset.extra.name)
		if (!(await isFile(extraTarget))) {
			onProgress?.(`正在下载内核组件 ${asset.extra.name}…`)
			await downloadFile(`${base}/${asset.extra.name}`, `${extraTarget}.part`, { expectedSha: asset.extra.sha256 })
			await rename(`${extraTarget}.part`, extraTarget)
		}
	}
	return { path: target, source: 'downloaded', asset: asset.name, version: CORE.version }
}

/** Remove a half-downloaded core so the next attempt starts clean. */
export async function discardPartialCore(dataDir) {
	await unlink(`${coreBinaryPath(dataDir)}.part`).catch(() => {})
}

/** Tag of the selector outbound every inbound routes to. */
export const SELECTOR_TAG = 'proxy'

/** How long a freshly spawned core may take to answer on its Clash API. */
const READY_TIMEOUT_MS = 12_000
/** How much child stderr we keep in memory for diagnostics. */
const STDERR_KEEP_BYTES = 4096

/** One Clash API call. Resolves with the parsed JSON body and status code. */
function clashRequest(port, method, path, body, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
		const req = httpRequest(
			{
				host: '127.0.0.1',
				port,
				method,
				path,
				headers: {
					accept: 'application/json',
					...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.length })
				}
			},
			(res) => {
				const chunks = []
				res.on('data', (chunk) => chunks.push(chunk))
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8')
					let json
					try {
						json = text === '' ? undefined : JSON.parse(text)
					} catch {
						json = undefined
					}
					resolve({ status: res.statusCode ?? 0, json, text })
				})
			}
		)
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`Clash API 超时（${timeoutMs}ms）`)))
		req.on('error', reject)
		if (payload !== undefined) req.write(payload)
		req.end()
	})
}

/** Sleep helper. */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build the core handle.
 * @param options - `dataDir` (state directory) and `logger`.
 * @returns the core handle.
 */
export function createCore({ dataDir, logger, binaryPath }) {
	/** Absolute path of the core executable, resolved lazily so a download can fill it in. */
	let binary = binaryPath
	const configFile = join(dataDir, 'sing-box.json')
	const logFile = join(dataDir, 'sing-box.log')
	/** @type {import('node:child_process').ChildProcess | undefined} */
	let child
	let logStream
	let stderrTail = ''
	let running = false
	let lastError = null
	let version = null
	let versionChecked = false
	/** Shape of the running config; a different shape needs a restart. */
	let runningSignature = null
	let clashPort = 0

	/** Rewrite the whole config document for the given nodes and ports. */
	async function writeConfig({ nodes, mixedPort, clashPort: clash, selectedTag }) {
		const tags = nodes.map((node) => node.tag)
		const document = {
			log: { level: 'warn', timestamp: true },
			inbounds: [
				{
					type: 'mixed',
					tag: 'mixed-in',
					listen: '127.0.0.1',
					listen_port: mixedPort
				}
			],
			outbounds: [
				...nodes.map((node) => ({ ...node.outbound, tag: node.tag })),
				{ type: 'direct', tag: 'direct' },
				{
					type: 'selector',
					tag: SELECTOR_TAG,
					outbounds: tags,
					...(selectedTag !== undefined && tags.includes(selectedTag) ? { default: selectedTag } : {}),
					interrupt_exist_connections: true
				}
			],
			route: { rules: [], final: SELECTOR_TAG },
			experimental: { clash_api: { external_controller: `127.0.0.1:${clash}` } }
		}
		await mkdir(dataDir, { recursive: true })
		await writeFile(configFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
	}

	/** Read the core's own version once, so Settings can show what is running. */
	async function readVersion() {
		if (versionChecked) return version
		versionChecked = true
		if (binary === undefined) binary = await existingCoreBinary({ dataDir })
		if (binary === undefined) return (version = null)
		await new Promise((resolve) => {
			const probe = spawn(binary, ['version'], { stdio: ['ignore', 'pipe', 'pipe'] })
			let out = ''
			probe.stdout?.on('data', (chunk) => {
				out += chunk
			})
			probe.on('error', () => resolve())
			probe.on('close', () => {
				const match = /sing-box version (\S+)/.exec(out)
				if (match !== null) version = match[1]
				resolve()
			})
		})
		return version
	}

	/** Append one diagnostic line to the durable core log. */
	function appendLog(text) {
		stderrTail = `${stderrTail}${text}`.slice(-STDERR_KEEP_BYTES)
		logStream?.write(text)
	}

	/** Stop the child process, if any. */
	async function stop() {
		const current = child
		child = undefined
		running = false
		runningSignature = null
		if (current === undefined) return
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				current.kill('SIGKILL')
				resolve()
			}, 2500)
			current.once('close', () => {
				clearTimeout(timer)
				resolve()
			})
			current.kill('SIGTERM')
		})
	}

	/** Poll the Clash API until the freshly started core answers. */
	async function waitReady(port) {
		const deadline = Date.now() + READY_TIMEOUT_MS
		while (Date.now() < deadline) {
			if (child === undefined) throw new Error(lastError ?? 'sing-box 已退出')
			try {
				const response = await clashRequest(port, 'GET', '/version', undefined, 1000)
				if (response.status === 200) return
			} catch {
				// Not up yet.
			}
			await delay(150)
		}
		throw new Error(`sing-box 在 ${READY_TIMEOUT_MS}ms 内没有就绪`)
	}

	/**
	 * Make the running core match the requested shape, starting or restarting it
	 * as needed. Returns the effective running state.
	 */
	async function sync(shape) {
		if (binary === undefined) binary = await existingCoreBinary({ dataDir, explicit: shape.binaryPath })
		await readVersion()
		const nodes = shape.nodes ?? []
		if (binary === undefined) {
			lastError = `内核未安装：请把 sing-box 放到 ${coreBinaryPath(dataDir)}，在「设置 → 网络代理」点「下载内核」也能自动完成`
			return { running: false, error: lastError, missingBinary: true }
		}
		if (nodes.length === 0) {
			await stop()
			lastError = null
			return { running: false }
		}
		const signature = JSON.stringify({
			nodes: nodes.map((node) => [node.tag, node.outbound]),
			mixedPort: shape.mixedPort,
			clashPort: shape.clashPort,
			// Only an explicit choice pins the core; the auto order is a runtime
			// concern, so measuring nodes never restarts the process.
			pinnedTag: shape.pinnedTag ?? null
		})
		if (running && runningSignature === signature) return { running: true }
		await stop()
		stderrTail = ''
		try {
			logStream?.end()
			logStream = createWriteStream(logFile, { flags: 'a' })
			logStream.on('error', () => {})
		} catch {
			logStream = undefined
		}
		await writeConfig(shape)
		clashPort = shape.clashPort
		const spawned = spawn(binary, ['run', '-c', configFile], {
			cwd: dataDir,
			stdio: ['ignore', 'pipe', 'pipe']
		})
		child = spawned
		spawned.stdout?.on('data', (chunk) => appendLog(String(chunk)))
		spawned.stderr?.on('data', (chunk) => appendLog(String(chunk)))
		spawned.on('error', (error) => {
			lastError = `无法启动 sing-box：${String(error.message ?? error)}`
			running = false
		})
		spawned.on('close', (code) => {
			if (child === spawned) {
				child = undefined
				running = false
				runningSignature = null
				if (code !== 0 && stderrTail.trim() !== '') lastError = stderrTail.trim().split('\n').slice(-4).join(' ')
				else if (code !== 0) lastError = `sing-box 退出（code ${code}）`
			}
		})
		try {
			await waitReady(shape.clashPort)
		} catch (error) {
			lastError = `${String(error.message ?? error)}${stderrTail.trim() === '' ? '' : `：${stderrTail.trim().split('\n').slice(-3).join(' ')}`}`
			running = false
			await stop()
			return { running: false, error: lastError }
		}
		running = true
		runningSignature = signature
		lastError = null
		return { running: true }
	}

	/** Point the selector at one node tag. */
	async function select(tag) {
		if (!running || clashPort === 0) throw new Error('sing-box 未运行')
		const response = await clashRequest(clashPort, 'PUT', `/proxies/${encodeURIComponent(SELECTOR_TAG)}`, { name: tag })
		if (response.status !== 204 && response.status !== 200) {
			throw new Error(`切换节点失败（HTTP ${response.status}）`)
		}
	}

	/** The selector's current choice, straight from the core. */
	async function current() {
		if (!running || clashPort === 0) return null
		const response = await clashRequest(clashPort, 'GET', `/proxies/${encodeURIComponent(SELECTOR_TAG)}`)
		if (response.status !== 200) return null
		return typeof response.json?.now === 'string' ? response.json.now : null
	}

	/**
	 * The most recent error line the core logged, for folding into a diagnostic.
	 * The Clash API answers a failed delay test with a generic message, so the
	 * child's own log is the only place the real cause (unreachable address, TLS
	 * rejection, bad UUID) appears.
	 * @returns a short single line, or `null` when the log says nothing useful.
	 */
	function lastErrorLine() {
		const lines = stderrTail.split('\n').filter((line) => /ERROR|FATAL/i.test(line))
		const last = lines.at(-1)
		if (last === undefined) return null
		const cleaned = last
			// sing-box colorizes its log; escape codes must not reach the model.
			.replace(/\u001b\[[0-9;]*m/g, '')
			.replace(/^.*?ERROR\s*/i, '')
			.replace(/\s+/g, ' ')
			.trim()
		return cleaned === '' ? null : cleaned.slice(0, 240)
	}

	/**
	 * Measure one node by asking the core to issue a request through it.
	 * @returns the latency in milliseconds.
	 */
	async function measure(tag, { url, timeoutMs = 5000 } = {}) {
		if (!running || clashPort === 0) throw new Error('sing-box 未运行')
		const target = url ?? 'https://cp.cloudflare.com/generate_204'
		const path = `/proxies/${encodeURIComponent(tag)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent(target)}`
		const response = await clashRequest(clashPort, 'GET', path, undefined, timeoutMs + 3000)
		if (response.status === 200 && Number.isFinite(response.json?.delay)) return Number(response.json.delay)
		const message =
			typeof response.json?.message === 'string' && response.json.message !== ''
				? response.json.message
				: `HTTP ${response.status}`
		// The core logs the failure a moment after answering the API call.
		await delay(200)
		const hint = lastErrorLine()
		throw new Error(hint === null ? message : `${message}（内核日志：${hint}）`)
	}

	return {
		configFile,
		logFile,
		get binary() {
			return binary
		},
		get installed() {
			return typeof binary === 'string' && existsSync(binary)
		},
		/** Download the core (when missing) and remember the resolved path. */
		async install({ mirror, signal, onProgress } = {}) {
			const result = await ensureCoreBinary({ dataDir, explicit: binaryPath, logger, mirror, signal, onProgress })
			binary = result.path
			versionChecked = false
			return result
		},
		get running() {
			return running
		},
		get lastError() {
			return lastError
		},
		get version() {
			return version
		},
		get clashPort() {
			return clashPort
		},
		get stderrTail() {
			return stderrTail
		},
		readVersion,
		sync,
		select,
		current,
		measure,
		stop,
		/** Release the log stream; the caller stops the process first. */
		async dispose() {
			await stop()
			logStream?.end()
			logStream = undefined
		}
	}
}
