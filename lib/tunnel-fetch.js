/**
 * One HTTP(S) request through the sing-box core, for dsh-egress-router's
 * agent tool.
 *
 * The proxy tool never uses the harness's global dispatcher: this module opens
 * its own tunnel to the core's mixed inbound and speaks HTTP over it, so a
 * single tool call is routed through a chosen node and nothing else in the
 * process changes. Redirects are followed, `identity` encoding is requested so
 * the body can be decoded without a decompressor, and the body is capped.
 *
 * @module dsh-egress-router/tunnel-fetch
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { connectThroughCore } from './router.js'

/** Connect to the core's mixed inbound and return the raw socket. */
function connectToCore(mixedPort, timeoutMs) {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: '127.0.0.1', port: mixedPort })
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`连接本地代理端口 ${mixedPort} 超时`))
		}, timeoutMs)
		socket.once('connect', () => {
			clearTimeout(timer)
			socket.setTimeout(0)
			resolve(socket)
		})
		socket.once('error', (error) => {
			clearTimeout(timer)
			reject(new Error(`连接本地代理端口 ${mixedPort} 失败：${String(error.message ?? error)}`))
		})
	})
}

/**
 * Issue one request through the core.
 * @param url - absolute request URL.
 * @param options - method, headers, body, timeout, maxBytes, and signal.
 * @returns `{ status, headers, body, truncated, url }`.
 */
export async function tunnelFetch(url, options = {}) {
	const { method = 'GET', headers = {}, body, timeoutMs = 20_000, maxBytes = 60_000, mixedPort, signal } = options
	const target = new URL(url)
	const secure = target.protocol === 'https:'
	const port = Number(target.port) || (secure ? 443 : 80)
	const host = target.hostname

	const socket = await connectThroughCore(host, port, mixedPort, Math.min(timeoutMs, 12_000))
	const agent = secure ? new HttpsTunnelAgent(host, socket) : new HttpTunnelAgent(socket)
	const requestHeaders = {
		host: target.host,
		'accept-encoding': 'identity',
		'user-agent': 'dsh-net-proxy/0.1 (+local agent tool)',
		...headers
	}
	const request = secure ? httpsRequest : httpRequest
	const requestBody = body === undefined || body === null ? undefined : Buffer.from(String(body), 'utf8')
	if (requestBody !== undefined && requestHeaders['content-length'] === undefined) {
		requestHeaders['content-length'] = String(requestBody.length)
	}
	const response = await new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port: 1,
				method,
				path: secure ? `${target.pathname}${target.search}` : target.href,
				headers: requestHeaders,
				agent,
				...(secure ? { servername: host } : {})
			},
			resolve
		)
		const timer = setTimeout(() => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
		const abort = () => req.destroy(new Error('请求已取消'))
		signal?.addEventListener('abort', abort, { once: true })
		req.on('close', () => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', abort)
		})
		req.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		if (requestBody !== undefined) req.write(requestBody)
		req.end()
	})

	const chunks = []
	let received = 0
	let truncated = false
	await new Promise((resolve, reject) => {
		response.on('data', (chunk) => {
			received += chunk.length
			// Keep every chunk and cut to `maxBytes` at the end: a first chunk larger
			// than the cap must still contribute its prefix, not vanish.
			chunks.push(chunk)
			if (received >= maxBytes) {
				truncated = true
				response.destroy()
				resolve()
			}
		})
		response.on('end', resolve)
		response.on('error', reject)
	})
	const responseHeaders = {}
	for (const [key, value] of Object.entries(response.headers)) {
		responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
	}
	return {
		url,
		status: response.statusCode ?? 0,
		headers: responseHeaders,
		body: Buffer.concat(chunks).subarray(0, maxBytes),
		truncated
	}
}

/** An agent that hands `node:http` the socket we already opened through the core. */
class HttpTunnelAgent extends HttpAgent {
	constructor(socket) {
		super({ keepAlive: false, maxSockets: 1 })
		this.socket = socket
	}
	createConnection() {
		return this.socket
	}
}

/**
 * The HTTPS twin: the same tunnel, wrapped in TLS for the target host. It must
 * extend `https.Agent` — `https.request` rejects an agent whose `protocol` is
 * not `https:`.
 */
class HttpsTunnelAgent extends HttpsAgent {
	constructor(servername, tunnel) {
		super({ keepAlive: false, maxSockets: 1 })
		this.servername = servername
		this.tunnel = tunnel
	}
	createConnection() {
		return tlsConnect({ socket: this.tunnel, servername: this.servername, rejectUnauthorized: true })
	}
}

/** Follow redirects, up to `maxHops`, through the same tunnel helper. */
export async function tunnelFetchFollowing(url, options = {}, maxHops = 5) {
	let current = url
	let response
	for (let hop = 0; hop <= maxHops; hop += 1) {
		response = await tunnelFetch(current, options)
		const location = response.headers.location
		if (![301, 302, 303, 307, 308].includes(response.status) || typeof location !== 'string' || location === '') {
			return response
		}
		current = new URL(location, current).href
		if (response.status === 303) options = { ...options, method: 'GET', body: undefined }
	}
	return response
}
