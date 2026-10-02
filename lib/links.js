/**
 * Share-link parsing for dsh-egress-router.
 *
 * One `parseShareLink()` call turns the text a user pastes (a `vless://`,
 * `vmess://`, `trojan://` or `ss://` link) into the normalized node record the
 * store persists plus the sing-box outbound that reaches it. Nothing here
 * touches the filesystem or the network: it is pure, so a bad link fails with a
 * message the Settings panel can show verbatim.
 *
 * @module dsh-egress-router/links
 */

/** Schemes this plugin understands. */
const SUPPORTED_SCHEMES = ['vless', 'vmess', 'trojan', 'ss']

/** Strip the brackets a URL host carries around an IPv6 literal. */
function bareHost(host) {
	const trimmed = String(host ?? '').trim()
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
	return trimmed
}

/** True for a bare IPv6 literal (contains a colon outside of any brackets). */
export function isIpv6Literal(host) {
	const value = bareHost(host)
	return value.includes(':')
}

/** Decode base64 that may be URL-safe and/or unpadded, as vmess/ss links use. */
function decodeBase64(value) {
	const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/').replaceAll(/\s+/g, '')
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
	return Buffer.from(padded, 'base64').toString('utf8')
}

/** Best-effort remark from a link fragment; never throws. */
function remarkFromFragment(url) {
	try {
		const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
		return decodeURIComponent(fragment).trim()
	} catch {
		return ''
	}
}

/** True for the strings that mean "on" in a query parameter. */
function isTruthy(value) {
	const text = String(value ?? '').trim().toLowerCase()
	return text === '1' || text === 'true' || text === 'yes'
}

/** Split a comma-separated list parameter, dropping empties. */
function list(value) {
	return String(value ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

/**
 * Build the sing-box `tls` block shared by vless/trojan.
 * @param security - `tls`, `reality`, `none`, or empty.
 * @param params - the link's query parameters.
 * @param server - the node's server address, used as the SNI fallback.
 * @returns the tls object, or `undefined` when the link asks for plaintext.
 */
function buildTls(security, params, server) {
	const mode = String(security ?? '').trim().toLowerCase()
	if (mode === '' || mode === 'none') return undefined
	const serverName = params.get('sni')?.trim() || params.get('host')?.trim() || bareHost(server)
	const fingerprint = params.get('fp')?.trim() || 'chrome'
	const alpn = list(params.get('alpn'))
	if (mode === 'reality') {
		const publicKey = params.get('pbk')?.trim()
		if (!publicKey) throw new Error('reality 链接缺少 pbk（服务端公钥）')
		return {
			enabled: true,
			server_name: serverName,
			utls: { enabled: true, fingerprint },
			...(alpn.length > 0 ? { alpn } : {}),
			reality: {
				enabled: true,
				public_key: publicKey,
				short_id: params.get('sid')?.trim() ?? ''
			}
		}
	}
	// `xtls` is an alias for tls on the wire.
	return {
		enabled: true,
		server_name: serverName,
		utls: { enabled: true, fingerprint },
		...(alpn.length > 0 ? { alpn } : {}),
		...(isTruthy(params.get('allowInsecure')) || isTruthy(params.get('insecure')) ? { insecure: true } : {})
	}
}

/**
 * Split a v2ray-style WS/HTTP path into the path the server matches and the
 * client-only directives Xray keeps in its query.
 *
 * `?ed=2048` is the important one: it is the *client* asking for early data, and
 * Xray strips it before the request line. sing-box does not — it sets the whole
 * string as the request path and escapes the `?` to `%3F` (verified against
 * sing-box's `transport/v2raywebsocket/client.go`, which calls Go's
 * `url.setPath`), so a server that matches `/vmess-argo` answers **404** and the
 * node looks dead. Handing sing-box a bare path is what makes these links work.
 *
 * @param value - the link's `path` parameter, query included.
 * @returns the path to send, plus the early-data size when the link asked for it.
 */
function splitPathQuery(value) {
	const text = String(value ?? '')
	const index = text.indexOf('?')
	if (index < 0) return { path: text }
	const query = new URLSearchParams(text.slice(index + 1))
	const early = Number(query.get('ed'))
	query.delete('ed')
	const rest = query.toString()
	return {
		path: rest === '' ? text.slice(0, index) : `${text.slice(0, index)}?${rest}`,
		...(Number.isInteger(early) && early > 0 ? { earlyData: early } : {})
	}
}

/**
 * Build the sing-box transport block (ws/grpc/http/h2/quic).
 * @param type - the link's `type` parameter.
 * @param headerType - the link's `headerType` parameter (tcp + http obfuscation).
 * @param params - the link's query parameters.
 * @returns the transport object, or `undefined` for a plain TCP node.
 */
function buildTransport(type, headerType, params) {
	const network = String(type ?? 'tcp').trim().toLowerCase()
	const rawPath = params.get('path')?.trim()
	const host = params.get('host')?.trim()
	const serviceName = params.get('serviceName')?.trim()
	switch (network) {
		case 'ws': {
			const { path, earlyData } = splitPathQuery(rawPath)
			return {
				type: 'ws',
				...(path !== '' ? { path } : {}),
				...(host !== undefined && host !== '' ? { headers: { Host: host } } : {}),
				// Early data is optional for the server, so it is only requested when
				// the link itself asked for it.
				...(earlyData === undefined
					? {}
					: { max_early_data: earlyData, early_data_header_name: 'Sec-WebSocket-Protocol' })
			}
		}
		case 'grpc':
			return { type: 'grpc', ...(serviceName !== undefined && serviceName !== '' ? { service_name: serviceName } : {}) }
		case 'http':
		case 'h2': {
			const { path } = splitPathQuery(rawPath)
			return {
				type: 'http',
				...(host !== undefined && host !== '' ? { host: list(host) } : {}),
				...(path !== '' ? { path } : {})
			}
		}
		case 'quic':
			return { type: 'quic' }
		case 'tcp':
			if (String(headerType ?? '').trim().toLowerCase() === 'http') {
				return { type: 'http', ...(host !== undefined && host !== '' ? { host: list(host) } : {}) }
			}
			return undefined
		default:
			return undefined
	}
}

/**
 * Parse a share link URL, with a message that names the real problem.
 *
 * WHATWG URL parsing rejects a malformed IPv6 literal outright ("Invalid URL"),
 * which is worth spelling out: a five-hex-digit group is the mistake users
 * actually paste, and "链接无效" would send them looking in the wrong place.
 * @param raw - the full link.
 * @param scheme - the scheme, for the message.
 * @returns the parsed URL.
 */
function parseUrl(raw, scheme) {
	try {
		return new URL(raw)
	} catch {
		const host = /@(\[[^\]]*\]|[^/?#]*)/.exec(raw)?.[1]
		if (host !== undefined && host.startsWith('[')) {
			const address = host.slice(1, -1)
			const tooLong = address.split(':').find((group) => group.length > 4)
			throw new Error(
				tooLong === undefined
					? `链接里的 IPv6 地址 ${host} 不是合法写法`
					: `链接里的 IPv6 地址 ${host} 不合法：每一段最多 4 位十六进制，但「${tooLong}」有 ${tooLong.length} 位`
			)
		}
		throw new Error(`${scheme} 链接格式无法解析`)
	}
}

/** Parse one `vless://` link into a node plus its sing-box outbound. */
function parseVless(raw) {
	const url = parseUrl(raw, 'vless')
	const uuid = decodeURIComponent(url.username)
	if (uuid.length === 0) throw new Error('vless 链接缺少 UUID')
	const server = bareHost(url.hostname)
	const port = Number(url.port)
	if (!Number.isInteger(port) || port <= 0) throw new Error('vless 链接缺少端口')
	const params = url.searchParams
	const tls = buildTls(params.get('security'), params, server)
	const transport = buildTransport(params.get('type'), params.get('headerType'), params)
	// `flow` only applies to a plain TCP transport; the server rejects it otherwise.
	const flow = params.get('flow')?.trim()
	return {
		protocol: 'vless',
		server,
		port,
		remark: remarkFromFragment(url),
		outbound: {
			type: 'vless',
			server,
			server_port: port,
			uuid,
			...(flow !== undefined && flow !== '' && transport === undefined ? { flow } : {}),
			...(tls !== undefined ? { tls } : {}),
			...(transport !== undefined ? { transport } : {})
		}
	}
}

/** Parse one `vmess://` link (base64 JSON, the v2rayN shape). */
function parseVmess(raw) {
	const payload = raw.slice('vmess://'.length).trim()
	let parsed
	try {
		parsed = JSON.parse(decodeBase64(payload))
	} catch {
		throw new Error('vmess 链接的 base64 内容不是合法 JSON')
	}
	if (parsed === null || typeof parsed !== 'object') throw new Error('vmess 链接内容无效')
	const server = bareHost(parsed.add)
	const port = Number(parsed.port)
	if (server === '' || !Number.isInteger(port) || port <= 0) throw new Error('vmess 链接缺少服务器地址或端口')
	const uuid = String(parsed.id ?? '').trim()
	if (uuid === '') throw new Error('vmess 链接缺少 UUID')
	const network = String(parsed.net ?? 'tcp').trim().toLowerCase()
	const headerType = String(parsed.type ?? '').trim().toLowerCase()
	const params = new URLSearchParams()
	if (parsed.path !== undefined) params.set('path', String(parsed.path))
	if (parsed.host !== undefined && String(parsed.host) !== '') params.set('host', String(parsed.host))
	if (parsed.serviceName !== undefined) params.set('serviceName', String(parsed.serviceName))
	const transport = buildTransport(network, headerType, params)
	const security = String(parsed.tls ?? '').trim().toLowerCase()
	const tls =
		security === 'tls' || security === 'reality'
			? (() => {
					const serverName = String(parsed.sni ?? '').trim() || String(parsed.host ?? '').trim() || server
					const fingerprint = String(parsed.fp ?? '').trim()
					// v2rayN writes `insecure: "1"` for "skip certificate verification";
					// without this mapping the core would refuse a self-signed node.
					const skipVerify = isTruthy(parsed.insecure) || isTruthy(parsed.allowInsecure)
					return {
						enabled: true,
						server_name: serverName,
						...(fingerprint !== '' ? { utls: { enabled: true, fingerprint } } : {}),
						...(list(parsed.alpn).length > 0 ? { alpn: list(parsed.alpn) } : {}),
						...(skipVerify ? { insecure: true } : {})
					}
				})()
			: undefined
	const alterId = Number(parsed.aid ?? 0)
	return {
		protocol: 'vmess',
		server,
		port,
		remark: String(parsed.ps ?? '').trim(),
		outbound: {
			type: 'vmess',
			server,
			server_port: port,
			uuid,
			security: String(parsed.scy ?? 'auto').trim() || 'auto',
			alter_id: Number.isInteger(alterId) && alterId >= 0 ? alterId : 0,
			...(tls !== undefined ? { tls } : {}),
			...(transport !== undefined ? { transport } : {})
		}
	}
}

/** Parse one `trojan://` link. */
function parseTrojan(raw) {
	const url = parseUrl(raw, 'trojan')
	const password = decodeURIComponent(url.username || url.password)
	if (password.length === 0) throw new Error('trojan 链接缺少密码')
	const server = bareHost(url.hostname)
	const port = Number(url.port)
	if (!Number.isInteger(port) || port <= 0) throw new Error('trojan 链接缺少端口')
	const params = url.searchParams
	const security = params.get('security')?.trim().toLowerCase() ?? 'tls'
	const tls = security === 'none' ? undefined : buildTls(security === 'reality' ? 'reality' : 'tls', params, server)
	const transport = buildTransport(params.get('type'), params.get('headerType'), params)
	return {
		protocol: 'trojan',
		server,
		port,
		remark: remarkFromFragment(url),
		outbound: {
			type: 'trojan',
			server,
			server_port: port,
			password,
			...(tls !== undefined ? { tls } : {}),
			...(transport !== undefined ? { transport } : {})
		}
	}
}

/** Parse one `ss://` link, in either the legacy whole-base64 or the SIP002 shape. */
function parseShadowsocks(raw) {
	let body = raw.slice('ss://'.length).trim()
	let remark = ''
	const hashIndex = body.indexOf('#')
	if (hashIndex >= 0) {
		try {
			remark = decodeURIComponent(body.slice(hashIndex + 1)).trim()
		} catch {
			remark = ''
		}
		body = body.slice(0, hashIndex)
	}
	const queryIndex = body.indexOf('?')
	if (queryIndex >= 0) body = body.slice(0, queryIndex)

	let method
	let password
	let server
	let port
	const atIndex = body.lastIndexOf('@')
	if (atIndex >= 0) {
		// SIP002: base64(method:password)@host:port
		const credentials = decodeBase64(body.slice(0, atIndex))
		const separator = credentials.indexOf(':')
		if (separator < 0) throw new Error('ss 链接的加密方式/密码无效')
		method = credentials.slice(0, separator)
		password = credentials.slice(separator + 1)
		const hostPart = body.slice(atIndex + 1)
		const closing = hostPart.lastIndexOf(']')
		const colon = closing >= 0 ? hostPart.indexOf(':', closing) : hostPart.lastIndexOf(':')
		if (colon < 0) throw new Error('ss 链接缺少端口')
		server = bareHost(hostPart.slice(0, colon))
		port = Number(hostPart.slice(colon + 1))
	} else {
		// Legacy: base64(method:password@host:port)
		const decoded = decodeBase64(body)
		const at = decoded.lastIndexOf('@')
		if (at < 0) throw new Error('ss 链接格式无法识别')
		const credentials = decoded.slice(0, at)
		const separator = credentials.indexOf(':')
		if (separator < 0) throw new Error('ss 链接的加密方式/密码无效')
		method = credentials.slice(0, separator)
		password = credentials.slice(separator + 1)
		const hostPart = decoded.slice(at + 1)
		const colon = hostPart.lastIndexOf(':')
		if (colon < 0) throw new Error('ss 链接缺少端口')
		server = bareHost(hostPart.slice(0, colon))
		port = Number(hostPart.slice(colon + 1))
	}
	if (server === '' || !Number.isInteger(port) || port <= 0) throw new Error('ss 链接缺少服务器地址或端口')
	if (!method) throw new Error('ss 链接缺少加密方式')
	return {
		protocol: 'ss',
		server,
		port,
		remark,
		outbound: { type: 'shadowsocks', server, server_port: port, method, password }
	}
}

const PARSERS = {
	vless: parseVless,
	vmess: parseVmess,
	trojan: parseTrojan,
	ss: parseShadowsocks
}

/** The scheme of a link, or `undefined` when this plugin does not support it. */
export function schemeOf(raw) {
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(String(raw ?? '').trim())
	if (match === null) return undefined
	const scheme = match[1].toLowerCase()
	return SUPPORTED_SCHEMES.includes(scheme) ? scheme : undefined
}

/**
 * Parse one share link.
 * @param raw - the pasted link text.
 * @returns the node fields and its tag-less sing-box outbound.
 * @throws {Error} with a Chinese message when the link cannot be used.
 */
export function parseShareLink(raw) {
	const text = String(raw ?? '').trim()
	if (text.length === 0) throw new Error('链接为空')
	const scheme = schemeOf(text)
	if (scheme === undefined) {
		const mentioned = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text)?.[1]?.toLowerCase()
		throw new Error(
			mentioned === undefined
				? '无法识别的链接：需要 vless:// vmess:// trojan:// 或 ss:// 开头'
				: `暂不支持 ${mentioned}:// 协议`
		)
	}
	try {
		return PARSERS[scheme](text)
	} catch (error) {
		if (error instanceof TypeError) throw new Error(`链接格式无效（${scheme}）`)
		throw error
	}
}

/** The schemes this plugin can import, for documentation and error text. */
export const supportedSchemes = [...SUPPORTED_SCHEMES]
