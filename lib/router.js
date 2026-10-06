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
/** How long an HTTP request may go without response headers before `auto` retries. */
const AUTO_RESPONSE_TIMEOUT_MS = 2500
/**
 * Head start the direct attempt gets in a race before the node joins it.
 *
 * A host that answers directly does so within one round trip, so a healthy path
 * wins before this expires and never pays for a node handshake. A blackholed one
 * stays silent, which is the signal to start the node attempt in parallel
 * instead of waiting out a long timeout.
 */
const RACE_HEAD_START_MS = 700
/** Longest a raced tunnel may take before the client is told it failed. */
const RACE_DEADLINE_MS = 12_000
/** How long a measured route decision is trusted before it is re-raced. */
const DIRECT_DECISION_TTL_MS = 10 * 60_000
const PROXY_DECISION_TTL_MS = 5 * 60_000
/** Methods that may be retried on another route without risking a double effect. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])
/**
 * Throughput sampling: how long a freshly committed tunnel is watched, and how
 * many bytes it must deliver in that window to count as healthy.
 *
 * A censored path often completes the handshake quickly and then throttles, so
 * "who answered first" alone would keep choosing a slow route. A route that
 * fails this sample is demoted for a while, which gives the other one the head
 * start on the next request.
 */
const HEALTH_SAMPLE_MS = 1200
const HEALTH_SAMPLE_BYTES = 8192
/** How long a demoted route lets the other one start first, and how long the demotion lasts. */
const SLOW_PENALTY_MS = 1500
const SLOW_PENALTY_TTL_MS = 2 * 60_000
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
	/**
	 * Which route won for a host, and when.
	 *
	 * This is the "choose by speed" memory: instead of trusting the routing list
	 * as a static claim about the network, the router measures once per host and
	 * reuses the winner until the entry expires (direct wins are trusted longer
	 * than node wins). Only then does the next request race again.
	 */
	const decisions = new Map()
	/** Routes demoted for slow throughput, keyed by host. */
	const penalties = new Map()
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

	/** A remembered decision for one host, if it is still fresh. */
	function decisionFor(host) {
		const entry = decisions.get(host)
		if (entry === undefined) return undefined
		const ttl = entry.via === 'direct' ? DIRECT_DECISION_TTL_MS : PROXY_DECISION_TTL_MS
		if (Date.now() - entry.at > ttl) {
			decisions.delete(host)
			return undefined
		}
		return entry
	}

	/** Remember which route won for a host, and record it for diagnostics. */
	function remember(host, via, detail) {
		decisions.set(host, { via, at: Date.now() })
		note(host, via, detail)
	}

	/** The demoted route for one host, if the demotion is still fresh. */
	function penaltyFor(host) {
		const entry = penalties.get(host)
		if (entry === undefined) return undefined
		if (Date.now() - entry.at > SLOW_PENALTY_TTL_MS) {
			penalties.delete(host)
			return undefined
		}
		return entry
	}

	/**
	 * Watch a committed tunnel's first moments and demote it when it trickles.
	 * @returns a disposer-free timer; the socket is only observed, never consumed.
	 */
	function watchThroughput(host, via, socket) {
		let bytes = 0
		const sample = (chunk) => {
			bytes += chunk.length
		}
		socket.on('data', sample)
		const timer = setTimeout(() => {
			socket.removeListener('data', sample)
			if (socket.destroyed) return
			if (bytes >= HEALTH_SAMPLE_BYTES) {
				penalties.delete(host)
				return
			}
			penalties.set(host, { via, at: Date.now() })
			decisions.delete(host)
			note(host, via, `吞吐过低（${HEALTH_SAMPLE_MS}ms 内仅 ${bytes} 字节），下次让另一条路先起跑`)
			logger.debug?.(`[dsh-egress-router] ${host} 经由 ${via} 吞吐过低（${bytes}B/${HEALTH_SAMPLE_MS}ms），已临时让另一条路优先`)
		}, HEALTH_SAMPLE_MS)
		timer.unref?.()
	}

	/**
	 * Decide how one host leaves this machine.
	 *
	 * `direct` / `proxy` are explicit user choices; `race` means "measure it":
	 * the caller starts a direct attempt, and the node joins either immediately
	 * (the host is on the routing list, so direct is *expected* to fail) or after
	 * {@link RACE_HEAD_START_MS}. Whichever produces the first upstream byte
	 * wins. `speedFirst: false` restores the older, blunter behaviour where the
	 * routing list forces the node without ever trying direct.
	 */
	function routeFor(host) {
		const policy = getPolicy()
		if (isLoopbackHost(host)) return 'direct'
		if (policy.mode === 'off') return 'direct'
		if (!policy.coreRunning) return 'direct'
		if (policy.mode === 'always') return 'proxy'
		const decided = decisionFor(host)
		if (decided !== undefined) return decided.via
		if (policy.speedFirst !== false) return 'race'
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
	/**
	 * Handle one `CONNECT host:port`.
	 *
	 * `direct` / `proxy` open exactly one upstream. Anything else is a **race**:
	 * the direct attempt starts at once and the node joins it — immediately for a
	 * host on the routing list (direct is expected to fail there), or after
	 * {@link RACE_HEAD_START_MS} otherwise. Whichever produces the first upstream
	 * byte wins; the client's buffered bytes are replayed onto the winner and the
	 * loser is torn down. That turns the routing list from an order ("always use
	 * the node") into a hint about where direct is likely to fail.
	 */
	function handleConnect(req, clientSocket, head) {
		const { host, port } = splitHostPort(req.url, 443)
		const via = routeFor(host)
		clientSocket.on('error', () => clientSocket.destroy())
		clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

		if (via === 'direct' || via === 'proxy') {
			openVia(host, port, via).then(
				(socket) => {
					count(via)
					note(host, via)
					if (head !== undefined && head.length > 0) socket.write(head)
					relay(clientSocket, socket)
				},
				(error) => {
					// An explicit route must not silently fall back to the other one:
					// `always` means the node, `off` means direct.
					failClient(clientSocket, String(error.message ?? error))
				}
			)
			return
		}

		const policy = getPolicy()
		const listed = matchesRoutes(host, policy.routes ?? [])
		/** Attempts still in the running; every loser is destroyed on commit. */
		const attempts = new Set()
		/** Client bytes kept until a winner is chosen, so a late attempt can replay them. */
		const replay = []
		let replayBytes = 0
		let replayable = true
		let committed = false
		let closed = false
		let directFailed = false
		let proxyFailed = false
		let raceTimer
		let deadline

		/** Forward one client chunk to every live attempt, keeping a copy for replays. */
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
			for (const socket of attempts) {
				if (!socket.destroyed) socket.write(chunk)
			}
		}

		clientSocket.on('data', deliver)
		clientSocket.on('close', () => {
			closed = true
			clientSocket.removeListener('data', deliver)
			for (const socket of attempts) socket.destroy()
		})
		if (head !== undefined && head.length > 0) deliver(head)

		/** Both attempts are dead: tell the client instead of hanging. */
		function maybeFail(reason) {
			if (committed || closed) return
			if (!(directFailed && proxyFailed)) return
			clearTimeout(raceTimer)
			clearTimeout(deadline)
			failClient(clientSocket, reason)
		}

		/** This attempt answered first: keep it, tear the others down, remember it. */
		function commit(socket, winner, detail) {
			if (committed || closed) {
				socket.destroy()
				return
			}
			committed = true
			clearTimeout(raceTimer)
			clearTimeout(deadline)
			clientSocket.removeListener('data', deliver)
			for (const other of attempts) {
				if (other !== socket) other.destroy()
			}
			attempts.clear()
			if (winner === 'proxy') {
				sticky.add(host)
				stats.fallback += 1
			}
			count(winner)
			remember(host, winner, detail)
			watchThroughput(host, winner, socket)
			relay(clientSocket, socket)
		}

		/** A freshly opened attempt inherits the bytes the client already sent. */
		function adopt(socket, winner, detail) {
			if (committed || closed) {
				socket.destroy()
				return
			}
			attempts.add(socket)
			for (const chunk of replay) socket.write(chunk)
			// Watch for the first upstream byte without consuming it, so `relay` can
			// still deliver that byte to the client.
			socket.pause()
			socket.once('readable', () => commit(socket, winner, detail))
			socket.once('error', (error) => {
				attempts.delete(socket)
				socket.destroy()
				if (winner === 'direct') directFailed = true
				else proxyFailed = true
				maybeFail(String(error.message ?? error))
			})
		}

		/** Join the race with the node attempt. */
		function startProxy(reason) {
			if (committed || closed) return
			connectThroughCore(host, port, policy.mixedPort, TUNNEL_TIMEOUT_MS).then(
				(socket) => adopt(socket, 'proxy', reason ?? '节点胜出（直连更慢）'),
				(error) => {
					proxyFailed = true
					maybeFail(String(error.message ?? error))
				}
			)
		}

		const penalty = penaltyFor(host)
		// A demoted route starts late, so the other one gets a real head start.
		const directDelayMs = penalty?.via === 'direct' ? SLOW_PENALTY_MS : 0
		const proxyDelayMs = (penalty?.via === 'proxy' ? SLOW_PENALTY_MS : 0) + (listed ? 0 : RACE_HEAD_START_MS)
		if (directDelayMs > 0) {
			note(host, 'direct', `上次吞吐过低，延后 ${directDelayMs}ms 起跑`)
			setTimeout(() => {
				connectDirect(host, port, PROBE_TIMEOUT_MS).then(
					(socket) => adopt(socket, 'direct', '直连胜出（追上了）'),
					(error) => {
						directFailed = true
						startProxy(`直连失败：${String(error.message ?? error)}`)
					}
				)
			}, directDelayMs)
		} else {
			connectDirect(host, port, PROBE_TIMEOUT_MS).then(
				(socket) => adopt(socket, 'direct', listed ? '直连胜出：名单内但直连更快' : undefined),
				(error) => {
					directFailed = true
					startProxy(`直连失败：${String(error.message ?? error)}`)
				}
			)
		}
		if (proxyDelayMs <= 0) startProxy('名单内域名：与直连同时竞速')
		else raceTimer = setTimeout(() => startProxy(`直连 ${proxyDelayMs}ms 内没有回应`), proxyDelayMs)
		deadline = setTimeout(() => {
			if (!committed) failClient(clientSocket, `直连与节点都没有在 ${RACE_DEADLINE_MS}ms 内建好隧道`)
		}, RACE_DEADLINE_MS)
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

		const idempotent = IDEMPOTENT_METHODS.has(String(req.method ?? 'GET').toUpperCase())
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

		// A GET can be replayed on the other route safely, so it gets a short
		// response watchdog; a POST must not be sent twice, so it is simply
		// reported if the first route fails.
		try {
			await send('direct', idempotent ? AUTO_RESPONSE_TIMEOUT_MS : undefined)
			count('direct')
			remember(host, 'direct', path)
		} catch (error) {
			if (res.headersSent) {
				res.destroy()
				return
			}
			if (!idempotent) {
				remember(host, 'proxy', '非幂等请求直连失败，改记为走节点')
				failRequest(res, error)
				return
			}
			markFallback(host, String(error.message ?? error))
			try {
				await send('proxy')
				count('proxy')
				remember(host, 'proxy', '自动回退')
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
		/** Live per-host route decisions, newest first, for the panel and the tool. */
		get decisions() {
			return [...decisions.entries()]
				.map(([host, entry]) => ({ host, via: entry.via, at: new Date(entry.at).toISOString(), ageMs: Date.now() - entry.at }))
				.sort((left, right) => right.ageMs - left.ageMs)
		},
		/** Routes currently demoted for slow throughput. */
		get penalties() {
			return [...penalties.entries()].map(([host, entry]) => ({
				host,
				via: entry.via,
				at: new Date(entry.at).toISOString(),
				ageMs: Date.now() - entry.at
			}))
		},
		/** Forget every measured decision, so the next request races again. */
		clearDecisions() {
			decisions.clear()
			penalties.clear()
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
