/**
 * The selective local HTTP proxy for dsh-egress-router.
 *
 * One loopback HTTP proxy (absolute-form requests plus `CONNECT`) that decides,
 * per request, whether traffic goes out directly or through the sing-box core:
 *
 * | mode     | decision                                                      |
 * |----------|---------------------------------------------------------------|
 * | `off`    | always direct                                                 |
 * | `auto`   | the routing list goes through the node; everything else tries  |
 * |          | direct first and falls back to the node on failure             |
 * | `always` | everything through the node                                   |
 *
 * "Failure" is deliberately not just a failed TCP connect. On a censored
 * network the connect succeeds and the handshake is what dies, so `auto` also
 * watches for progress: a `CONNECT` tunnel that carries no byte back within
 * {@link AUTO_BYTE_TIMEOUT_MS} is re-established through the core with the
 * client's buffered bytes replayed (a TLS ClientHello replays fine on a fresh
 * connection), and an HTTP request that produces no response headers within
 * {@link AUTO_RESPONSE_TIMEOUT_MS} is retried through the core.
 *
 * Loopback never goes through a node — that would route the harness's own UI
 * traffic into a loop. A host that needed the fallback once is remembered for
 * the life of the process, so the first request to a blocked host pays the
 * watchdog and every later one does not.
 *
 * @module dsh-egress-router/router
 */

import { Agent as HttpAgent, createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

/** How long `auto` waits for a direct connection before using the node. */
const PROBE_TIMEOUT_MS = 2500
/** How long a `CONNECT` tunnel may stay silent before `auto` switches to a node. */
const AUTO_BYTE_TIMEOUT_MS = 4000
/** How long an HTTP request may go without response headers before `auto` retries. */
const AUTO_RESPONSE_TIMEOUT_MS = 6000
/** How long any connection to the core, or through it, may take. */
const TUNNEL_TIMEOUT_MS = 8000
/** Largest request body this proxy buffers, so an `auto` retry can replay it. */
const MAX_BUFFERED_BODY = 2 * 1024 * 1024
/** Largest client→upstream prefix buffered while a `CONNECT` tunnel is undecided. */
const MAX_BUFFERED_TUNNEL = 256 * 1024
/** Hop-by-hop headers that must not be forwarded. */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
])

/** True for an address that must never leave through a proxy. */
export function isLoopbackHost(host) {
	const value = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
	if (value === '' || value === 'localhost' || value === '::1' || value === '0.0.0.0') return true
	if (/^127\./.test(value)) return true
	return false
}

/** True when `host` is `route` itself or one of its subdomains. */
export function matchesRoutes(host, routes) {
	const value = String(host ?? '').trim().toLowerCase()
	if (value === '') return false
	return routes.some((route) => value === route || value.endsWith(`.${route}`))
}

/** Split `host:port` (with IPv6 brackets) into its parts. */
function splitHostPort(value, fallbackPort) {
	const text = String(value ?? '').trim()
	if (text.startsWith('[')) {
		const closing = text.indexOf(']')
		const host = text.slice(1, closing)
		const rest = text.slice(closing + 1)
		return { host, port: rest.startsWith(':') ? Number(rest.slice(1)) || fallbackPort : fallbackPort }
	}
	const colon = text.lastIndexOf(':')
	if (colon < 0) return { host: text, port: fallbackPort }
	return { host: text.slice(0, colon), port: Number(text.slice(colon + 1)) || fallbackPort }
}

/** Open a TCP connection, rejecting after `timeoutMs`. */
function connectDirect(host, port, timeoutMs) {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host, port })
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`))
		}, timeoutMs)
		socket.once('connect', () => {
			clearTimeout(timer)
			socket.setTimeout(0)
			resolve(socket)
		})
		socket.once('error', (error) => {
			clearTimeout(timer)
			socket.destroy()
			reject(error)
		})
	})
}

/**
 * Open a connection to the sing-box core and ask it for a tunnel to
 * `host:port` (`CONNECT`). The resolved socket is already speaking the target
 * protocol.
 */
export function connectThroughCore(host, port, mixedPort, timeoutMs) {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: '127.0.0.1', port: mixedPort })
		let settled = false
		let buffered = Buffer.alloc(0)
		const fail = (error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			socket.destroy()
			reject(error)
		}
		const timer = setTimeout(() => fail(new Error(`经内核建立隧道超时（${timeoutMs}ms）`)), timeoutMs)
		socket.on('error', (error) => fail(new Error(`连接内核失败：${String(error.message ?? error)}`)))
		socket.once('connect', () => {
			socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
		})
		socket.on('data', function onData(chunk) {
			if (settled) return
			buffered = Buffer.concat([buffered, chunk])
			const end = buffered.indexOf('\r\n\r\n')
			if (end < 0) {
				if (buffered.length > 16 * 1024) fail(new Error('内核返回的隧道响应异常'))
				return
			}
			socket.removeListener('data', onData)
			const head = buffered.subarray(0, end).toString('latin1')
			const rest = buffered.subarray(end + 4)
			const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0)
			if (status !== 200) {
				fail(new Error(`内核拒绝建立隧道（${head.split('\r\n')[0] || '无响应'}）`))
				return
			}
			settled = true
			clearTimeout(timer)
			socket.setTimeout(0)
			if (rest.length > 0) socket.unshift(rest)
			resolve(socket)
		})
	})
}

/**
 * Build the router.
 * @param options - `getPolicy()` returns the live routing policy.
 * @returns the router handle.
 */
export function createRouter({ getPolicy, logger }) {
	/** Hosts that needed the fallback once; remembered for this process. */
	const sticky = new Set()
	const stats = { direct: 0, proxy: 0, fallback: 0, errors: 0 }
	/** Last decisions, newest first — shown in Settings and by the agent tool. */
	const recent = []
	let server
	let boundPort = 0

	/** Record one decision for diagnostics. */
	function note(host, via, detail) {
		recent.unshift({ at: new Date().toISOString(), host, via, ...(detail === undefined ? {} : { detail }) })
		if (recent.length > 30) recent.length = 30
	}

	/** Decide how one host leaves this machine. */
	function routeFor(host) {
		const policy = getPolicy()
		if (isLoopbackHost(host)) return 'direct'
		if (policy.mode === 'off') return 'direct'
		if (!policy.coreRunning) return 'direct'
		if (policy.mode === 'always') return 'proxy'
		if (sticky.has(host) || matchesRoutes(host, policy.routes ?? [])) return 'proxy'
		return 'auto'
	}

	/** Open an upstream socket for one explicit route. */
	function openVia(host, port, via) {
		const policy = getPolicy()
		if (via === 'direct') return connectDirect(host, port, TUNNEL_TIMEOUT_MS)
		return connectThroughCore(host, port, policy.mixedPort, TUNNEL_TIMEOUT_MS)
	}

	/** Remember that this host needs a node, and count the fallback. */
	function markFallback(host, reason) {
		sticky.add(host)
		stats.fallback += 1
		note(host, 'fallback', String(reason ?? ''))
		logger.debug?.(`[dsh-net-proxy] ${host} 直连失败，改走节点：${String(reason ?? '')}`)
	}

	/** Count one completed decision. */
	function count(via) {
		if (via === 'proxy') stats.proxy += 1
		else stats.direct += 1
	}

	/** Close a client socket that has not been answered yet. */
	function failClient(clientSocket, message) {
		stats.errors += 1
		note('(client)', 'error', message)
		if (clientSocket.writable) {
			clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
		} else {
			clientSocket.destroy()
		}
	}

	/**
	 * Handle one `CONNECT host:port`.
	 *
	 * In `auto` mode the tunnel is provisional: the client's bytes are forwarded
	 * to the direct connection *and* kept in a replay buffer, so a handshake that
	 * gets no answer past the watchdog can be rebuilt through the core without
	 * the client ever noticing.
	 */
	function handleConnect(req, clientSocket, head) {
		const { host, port } = splitHostPort(req.url, 443)
		const via = routeFor(host)
		clientSocket.on('error', () => clientSocket.destroy())
		clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

		if (via !== 'auto') {
			openVia(host, port, via).then(
				(socket) => {
					count(via)
					note(host, via)
					if (head !== undefined && head.length > 0) socket.write(head)
					relay(clientSocket, socket)
				},
				(error) => {
					// A routed host whose node is dead must not silently fall back to
					// direct: the caller asked for the node.
					failClient(clientSocket, String(error.message ?? error))
				}
			)
			return
		}

		/** The socket client bytes go to right now (the direct attempt). */
		let current = null
		/** Client bytes kept for a possible replay onto a fresh tunnel. */
		const replay = []
		let replayBytes = 0
		let replayable = true
		/** The tunnel is decided: no more interception. */
		let committed = false
		let closed = false

		/** Forward one client chunk, keeping a copy while the tunnel is undecided. */
		function deliver(chunk) {
			if (committed || closed) return
			if (replayable) {
				if (replayBytes + chunk.length > MAX_BUFFERED_TUNNEL) {
					replayable = false
					replay.length = 0
					replayBytes = 0
				} else {
					replay.push(chunk)
					replayBytes += chunk.length
				}
			}
			if (current !== null && !current.destroyed) current.write(chunk)
		}

		clientSocket.on('data', deliver)
		clientSocket.on('close', () => {
			closed = true
			clientSocket.removeListener('data', deliver)
		})
		if (head !== undefined && head.length > 0) deliver(head)

		/** Settle on one upstream: replay the kept bytes, then pipe both ways. */
		function commit(socket) {
			if (committed || closed) {
				socket.destroy()
				return
			}
			committed = true
			clientSocket.removeListener('data', deliver)
			if (socket !== current) {
				for (const chunk of replay) socket.write(chunk)
			}
			replay.length = 0
			replayBytes = 0
			relay(clientSocket, socket)
		}

		/** Rebuild this tunnel through the core, replaying the kept bytes. */
		function swap(reason) {
			if (committed || closed) return
			clearTimeout(watchdog)
			markFallback(host, reason)
			const dying = current
			current = null
			if (dying !== null) {
				dying.removeListener('readable', onReadable)
				dying.removeListener('error', onDirectError)
				dying.destroy()
			}
			const policy = getPolicy()
			connectThroughCore(host, port, policy.mixedPort, TUNNEL_TIMEOUT_MS).then(
				(socket) => {
					if (committed || closed) {
						socket.destroy()
						return
					}
					count('proxy')
					note(host, 'proxy', '自动回退')
					commit(socket)
				},
				(error) => failClient(clientSocket, String(error.message ?? error))
			)
		}

		/** The direct tunnel produced a byte: it works, keep it. */
		function onReadable() {
			clearTimeout(watchdog)
			const socket = current
			if (socket === null) return
			socket.removeListener('error', onDirectError)
			count('direct')
			note(host, 'direct')
			commit(socket)
		}

		function onDirectError(error) {
			clearTimeout(watchdog)
			swap(String(error.message ?? error))
		}

		let watchdog
		connectDirect(host, port, PROBE_TIMEOUT_MS).then(
			(direct) => {
				if (committed || closed) {
					direct.destroy()
					return
				}
				current = direct
				// Anything already captured (the CONNECT head, early client bytes)
				// must reach the direct attempt too, or a healthy host would stall.
				for (const chunk of replay) direct.write(chunk)
				direct.pause()
				direct.once('readable', onReadable)
				direct.once('error', onDirectError)
				watchdog = setTimeout(() => {
					direct.removeListener('readable', onReadable)
					swap(`直连 ${host}:${port} 在 ${AUTO_BYTE_TIMEOUT_MS}ms 内没有回应`)
				}, AUTO_BYTE_TIMEOUT_MS)
			},
			(error) => swap(String(error.message ?? error))
		)
	}

	/** Pipe a decided tunnel in both directions, tearing both ends down together. */
	function relay(clientSocket, upstream) {
		if (clientSocket.destroyed || upstream.destroyed) {
			clientSocket.destroy()
			upstream.destroy()
			return
		}
		upstream.on('error', () => clientSocket.destroy())
		clientSocket.on('error', () => upstream.destroy())
		upstream.pipe(clientSocket)
		clientSocket.pipe(upstream)
	}

	/** Read a request body into memory so an `auto` retry can replay it. */
	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = []
			let size = 0
			req.on('data', (chunk) => {
				size += chunk.length
				if (size > MAX_BUFFERED_BODY) {
					reject(new Error('请求体过大，无法缓存重试'))
					req.destroy()
					return
				}
				chunks.push(chunk)
			})
			req.on('end', () => resolve(Buffer.concat(chunks)))
			req.on('error', reject)
		})
	}

	/**
	 * Handle one absolute-form (or origin-form) HTTP request.
	 *
	 * In `auto` mode a direct attempt that produces no response headers within
	 * the watchdog is retried through the core with the same body.
	 */
	async function handleRequest(req, res) {
		let target
		try {
			target = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host ?? 'localhost'}${req.url}`)
		} catch {
			res.writeHead(400, { connection: 'close' }).end('bad request target')
			return
		}
		const host = target.hostname
		const port = Number(target.port) || 80
		const path = `${target.pathname}${target.search}`
		const absolute = `http://${target.host}${path}`
		const via = routeFor(host)

		const headers = {}
		for (const [key, value] of Object.entries(req.headers)) {
			if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value
		}
		let body
		try {
			body = await readBody(req)
		} catch (error) {
			res.writeHead(413, { connection: 'close' }).end(String(error.message ?? error))
			return
		}

		/** Send the request through one route; resolves once the response is piped. */
		function send(route, guardMs) {
			return new Promise((resolve, reject) => {
				openVia(host, port, route).then(
					(socket) => {
						const agent = new HttpAgent({ keepAlive: false, maxSockets: 1 })
						agent.createConnection = () => socket
						const options = {
							host: '127.0.0.1',
							port: 1,
							method: req.method,
							path: route === 'proxy' ? absolute : path,
							headers: { ...headers, ...(body.length > 0 ? { 'content-length': String(body.length) } : {}) },
							agent
						}
						const upstream = httpRequest(options, (response) => {
							if (guard !== undefined) clearTimeout(guard)
							const responseHeaders = {}
							for (const [key, value] of Object.entries(response.headers)) {
								if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value
							}
							responseHeaders.connection = 'close'
							res.writeHead(response.statusCode ?? 502, responseHeaders)
							response.pipe(res)
							resolve()
						})
						const guard =
							guardMs === undefined
								? undefined
								: setTimeout(() => upstream.destroy(new Error(`直连 ${host} 在 ${guardMs}ms 内没有响应`)), guardMs)
						upstream.on('error', (error) => {
							if (guard !== undefined) clearTimeout(guard)
							reject(error)
						})
						if (body.length > 0) upstream.write(body)
						upstream.end()
					},
					(error) => reject(error)
				)
			})
		}

		if (via === 'direct' || via === 'proxy') {
			try {
				await send(via)
				count(via)
				note(host, via, path)
			} catch (error) {
				failRequest(res, error)
			}
			return
		}

		try {
			await send('direct', AUTO_RESPONSE_TIMEOUT_MS)
			count('direct')
			note(host, 'direct', path)
		} catch (error) {
			if (res.headersSent) {
				res.destroy()
				return
			}
			markFallback(host, String(error.message ?? error))
			try {
				await send('proxy')
				count('proxy')
				note(host, 'proxy', '自动回退')
			} catch (fallbackError) {
				failRequest(res, fallbackError)
			}
		}
	}

	/** Answer a request that never produced a response. */
	function failRequest(res, error) {
		stats.errors += 1
		note('(request)', 'error', String(error.message ?? error))
		if (!res.headersSent) {
			res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
			res.end(`dsh-net-proxy: ${String(error.message ?? error)}\n`)
		} else {
			res.destroy()
		}
	}

	return {
		get port() {
			return boundPort
		},
		get sticky() {
			return [...sticky]
		},
		get stats() {
			return { ...stats }
		},
		get recent() {
			return [...recent]
		},
		/**
		 * Bind the proxy.
		 * @param port - loopback port to listen on.
		 */
		async start(port) {
			await this.stop()
			server = createServer((req, res) => {
				handleRequest(req, res).catch((error) => {
					failRequest(res, error)
					logger.debug?.(`[dsh-net-proxy] 转发失败：${String(error)}`)
				})
			})
			server.on('connect', (req, clientSocket, head) => handleConnect(req, clientSocket, head))
			server.on('upgrade', (req, socket) => {
				socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n')
			})
			server.on('clientError', (error, socket) => {
				if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
				else socket.destroy()
			})
			await new Promise((resolve, reject) => {
				server.once('error', reject)
				server.listen(port, '127.0.0.1', () => {
					server.removeListener('error', reject)
					boundPort = server.address().port
					resolve()
				})
			})
			return boundPort
		},
		async stop() {
			const current = server
			server = undefined
			boundPort = 0
			if (current === undefined) return
			await new Promise((resolve) => current.close(() => resolve()))
		}
	}
}

// hmr probe: 1790907963
