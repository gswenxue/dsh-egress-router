/**
 * dsh-egress-router — client half.
 *
 * Adds a "网络代理" section to the DSH Settings dialog: it reports the sing-box
 * core state, switches the proxy mode (关闭 / 智能 / 全局), imports vless /
 * vmess / trojan / ss share links, keeps the node library (rename, select,
 * test, delete), edits the 智能-mode route suffix list and shows the local
 * proxy URL the agent can use. Every mutation is a request to the host half,
 * which owns the node file, the core process and the local proxy.
 *
 * Hand-written as a `window.__ModuleLoader__` factory (no build step): the
 * package has no bundler dependency, so the bundle is the source here.
 *
 * Controls come from `@deepseek-ai/dsh-client-ui-primitives` (part of the
 * shell's frozen platform table, so it needs no `dsh.client.external` entry),
 * and its form fields are styled with the same `--dsw-alias-*` /
 * `--dsw-radius-*` tokens that `Input.module.css` uses. Never hardcode colors
 * here: the tokens are what make one stylesheet read correctly in both themes.
 */
window.__ModuleLoader__.load({
	id: 'dsh-egress-router',
	factory: (require) => {
		const React = require('react')
		const ui = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement

		const RPC_ENDPOINT = 'dsh-egress-router'
		const STYLE_ID = 'dsh-net-proxy-settings-styles'
		const MAX_REMARK = 80
		const LINK_PREVIEW = 96
		const ERROR_PREVIEW = 140

		/** The three proxy modes, in display order, as the host spells them. */
		const MODE_OPTIONS = [
			{ value: 'off', label: '关闭' },
			{ value: 'auto', label: '智能' },
			{ value: 'always', label: '全局' }
		]
		/** Human labels for the current mode tag. */
		const MODE_LABEL = { off: '关闭', auto: '智能', always: '全局' }
		/** One realistic share link as the import placeholder. */
		const LINK_PLACEHOLDER =
			'vless://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0@203.0.113.10:443?encryption=none&security=tls&type=ws&host=example.com&path=%2Fws#日本-01'
		/** Node status → `ui.Tag` tone and Chinese label. */
		const STATUS_META = {
			ok: { tone: 'success', label: '正常' },
			fail: { tone: 'danger', label: '失效' },
			// Failed for a reason that belongs to this machine (no IPv6 egress, …),
			// so the node itself is not judged.
			blocked: { tone: 'warning', label: '本机不可用' },
			unknown: { tone: 'neutral', label: '未测' }
		}
		/** Core running state → `ui.StateDot` state. */
		const CORE_DOT = { running: 'done', stopped: 'idle', error: 'error' }

		/**
		 * Pseudo-elements and focus rings cannot be expressed as inline styles, so
		 * the form controls ride a small injected stylesheet instead.
		 * @returns a disposer that removes the sheet when the plugin unloads.
		 */
		function installStyles() {
			if (globalThis.document?.getElementById(STYLE_ID) !== null) return () => {}
			const element = globalThis.document.createElement('style')
			element.id = STYLE_ID
			element.textContent = `
.dshnp-field {
	box-sizing: border-box;
	width: 100%;
	height: 32px;
	padding: 0 8px;
	border: 0.5px solid var(--dsw-alias-border-l4);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-primary);
	font-family: inherit;
	font-size: 14px;
	line-height: 22px;
	outline: none;
}
.dshnp-field:focus { border-color: var(--dsw-alias-state-business-primary); }
.dshnp-field::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshnp-textarea {
	box-sizing: border-box;
	width: 100%;
	min-height: 118px;
	padding: 8px 10px;
	border: 0.5px solid var(--dsw-alias-border-l4);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-primary);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12px;
	line-height: 1.6;
	resize: vertical;
	outline: none;
}
.dshnp-textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
.dshnp-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
`
			globalThis.document.head.append(element)
			return () => element.remove()
		}

		const styles = {
			root: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px 24px' },
			lede: { margin: 0, fontSize: '13px', lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' },
			panel: {
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
				padding: '14px 16px',
				border: '0.5px solid var(--dsw-alias-border-l3)',
				borderRadius: 'var(--dsw-radius-lg)',
				background: 'var(--dsw-alias-bg-layer-1)'
			},
			label: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
			statusRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			statusItem: {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				fontSize: '13px',
				fontWeight: 600,
				color: 'var(--dsw-alias-label-primary)'
			},
			bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			spacer: { flex: '1 1 auto' },
			hint: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
			error: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-error)' },
			errorLine: {
				margin: 0,
				fontSize: '12px',
				lineHeight: 1.5,
				color: 'var(--dsw-alias-label-error)',
				wordBreak: 'break-all'
			},
			ok: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-state-success-primary)' },
			warn: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-state-warn-label)' },
			mono: {
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
				fontSize: '12px',
				color: 'var(--dsw-alias-label-primary)',
				wordBreak: 'break-all'
			},
			urlRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			link: {
				margin: 0,
				fontSize: '11px',
				lineHeight: 1.5,
				color: 'var(--dsw-alias-label-dimmed)',
				wordBreak: 'break-all'
			},
			switchRow: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
			switchText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
			switchTitle: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
			chipRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
			chip: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '2px',
				padding: '2px 4px 2px 8px',
				border: '0.5px solid var(--dsw-alias-border-l4)',
				borderRadius: 'var(--dsw-radius-sm)',
				background: 'var(--dsw-alias-bg-layer-2)'
			},
			chipText: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)' },
			chipRemove: {
				border: 'none',
				background: 'transparent',
				color: 'var(--dsw-alias-label-tertiary)',
				cursor: 'pointer',
				fontSize: '14px',
				lineHeight: 1,
				padding: '0 2px'
			},
			list: { display: 'flex', flexDirection: 'column', gap: '8px' },
			nodeCard: {
				display: 'flex',
				alignItems: 'flex-start',
				gap: '12px',
				padding: '12px 14px',
				border: '0.5px solid var(--dsw-alias-border-l3)',
				borderRadius: 'var(--dsw-radius-lg)',
				background: 'var(--dsw-alias-bg-layer-1)'
			},
			nodeCardActive: { borderColor: 'var(--dsw-alias-state-business-primary)' },
			nodeBody: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, flex: '1 1 auto' },
			nodeName: {
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				fontSize: '14px',
				fontWeight: 600,
				color: 'var(--dsw-alias-label-primary)',
				wordBreak: 'break-all'
			},
			nodeMeta: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			nodeActions: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'flex-end',
				gap: '2px',
				flexWrap: 'wrap',
				flex: '0 0 auto',
				maxWidth: '220px'
			},
			empty: {
				padding: '24px 16px',
				border: '0.5px dashed var(--dsw-alias-border-l3)',
				borderRadius: 'var(--dsw-radius-lg)',
				textAlign: 'center',
				fontSize: '13px',
				color: 'var(--dsw-alias-label-tertiary)'
			},
			counter: { fontSize: '11px', color: 'var(--dsw-alias-label-dimmed)' },
			remarkField: { flex: '1 1 200px', minWidth: '160px' },
			routeField: { flex: '1 1 220px', minWidth: '160px' },
			footer: {
				margin: 0,
				fontSize: '11px',
				lineHeight: 1.6,
				color: 'var(--dsw-alias-label-dimmed)',
				wordBreak: 'break-all'
			}
		}

		/**
		 * Turn any thrown value into a message the panel can show as-is.
		 * @param error - whatever the RPC rejected with.
		 * @returns the host's message when there is one, a generic line otherwise.
		 */
		function describe(error) {
			if (error === null || error === undefined) return '代理操作失败，请重试。'
			if (typeof error.message === 'string' && error.message.length > 0) return error.message
			return String(error)
		}

		/**
		 * Shorten a long string for one-line display.
		 * @param text - the raw text, possibly not a string.
		 * @param max - characters kept before the ellipsis.
		 * @returns the text, cut to `max` characters plus an ellipsis when longer.
		 */
		function truncate(text, max) {
			const value = typeof text === 'string' ? text : ''
			return value.length > max ? `${value.slice(0, max)}…` : value
		}

		/**
		 * Format an ISO timestamp for the node card.
		 * @param value - the host's timestamp string.
		 * @returns a local time string, or the raw value when it is not a date.
		 */
		function formatTime(value) {
			if (typeof value !== 'string' || value.length === 0) return ''
			const date = new Date(value)
			return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
		}

		/**
		 * Normalize one route entry the way the host stores domain suffixes.
		 * @param raw - what the user typed.
		 * @returns the lower-cased suffix without a leading dot or `*.` wildcard.
		 */
		function normalizeRoute(raw) {
			return raw.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '')
		}

		/**
		 * Select an element's text so the user can copy it by hand when the
		 * Clipboard API is unavailable (plain-http origins have no clipboard).
		 * @param node - the element whose text should be selected.
		 */
		function selectText(node) {
			const selection = globalThis.getSelection?.()
			if (!node || !selection || !globalThis.document) return
			const range = globalThis.document.createRange()
			range.selectNodeContents(node)
			selection.removeAllRanges()
			selection.addRange(range)
		}

		/**
		 * Build the Settings section for one plugin instance. The connection is
		 * resolved per call so a reconnected client never keeps a stale transport.
		 */
		function createNetworkProxySection(ctx) {
			/**
			 * Send one RPC to the host half.
			 * @param method - one of the host contract's method names.
			 * @param payload - that method's payload object.
			 * @param signal - optional AbortSignal for the transport.
			 * @returns the method's `value`; rejects with a displayable Error otherwise.
			 */
			async function call(method, payload, signal) {
				const result = await ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method, payload }, signal)
				if (result?.ok === true) return result.value
				const error = new Error(result?.error?.message ?? '代理请求失败，请重试。')
				error.code = result?.error?.code
				throw error
			}

			return function NetworkProxySection() {
				const [snapshot, setSnapshot] = React.useState(null)
				const [error, setError] = React.useState(null)
				const [notice, setNotice] = React.useState(null)
				const [busy, setBusy] = React.useState(false)
				const [coreInstalling, setCoreInstalling] = React.useState(false)
				const [mirrorDraft, setMirrorDraft] = React.useState('')
				const [testingId, setTestingId] = React.useState(null)
				const [importText, setImportText] = React.useState('')
				const [importRemark, setImportRemark] = React.useState('')
				const [importReport, setImportReport] = React.useState(null)
				const [routeDraft, setRouteDraft] = React.useState('')
				const [editingId, setEditingId] = React.useState(null)
				const [editingRemark, setEditingRemark] = React.useState('')
				const proxyUrlRef = React.useRef(null)
				const abortRef = React.useRef(null)

				React.useEffect(() => {
					const controller = new AbortController()
					abortRef.current = controller
					call('list', {}, controller.signal)
						.then((value) => {
							if (controller.signal.aborted) return
							setSnapshot(value ?? null)
							setError(null)
						})
						.catch((cause) => {
							if (!controller.signal.aborted) setError(describe(cause))
						})
					return () => {
						controller.abort()
						abortRef.current = null
					}
				}, [])

				/**
				 * Whether this panel is still mounted, so a late RPC reply never
				 * writes state into an unmounted section.
				 * @returns true until the mount effect's cleanup ran.
				 */
				const mounted = () => abortRef.current !== null

				const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
				const routes = Array.isArray(snapshot?.routes) ? snapshot.routes : []
				const core = snapshot?.core ?? null
				const mode = typeof snapshot?.mode === 'string' ? snapshot.mode : 'off'
				const selectedId = snapshot?.selectedId ?? null
				const proxyUrl = typeof snapshot?.proxyUrl === 'string' ? snapshot.proxyUrl : ''
				const exampleUrl = proxyUrl.length > 0 ? proxyUrl : 'http://127.0.0.1:30810'
				const selectedNode = nodes.find((node) => node.id === selectedId) ?? null
				// The mirror field follows whatever the host reports until the user edits it.
				React.useEffect(() => {
					setMirrorDraft(snapshot?.core?.mirror ?? '')
				}, [snapshot?.core?.mirror])
				/** Nodes this machine could never reach, even when everything else works. */
				const ipv6NodeCount = nodes.filter((node) => node.ipv6Only === true).length
				const coreDot =
					core === null ? CORE_DOT.stopped : core.error ? CORE_DOT.error : core.running ? CORE_DOT.running : CORE_DOT.stopped
				const coreText =
					core === null ? '内核状态未知' : core.error ? '内核出错' : core.running ? '内核运行中' : '内核未运行'

				/**
				 * Run one mutation and fold the returned Snapshot back into state.
				 * Every call carries the section's AbortSignal, so unmounting the
				 * panel cancels whatever is still in flight.
				 * @param method - the contract method to call.
				 * @param payload - its payload.
				 * @returns the host value, or null when the call failed (error is shown).
				 */
				const run = React.useCallback(async (method, payload) => {
					setBusy(true)
					setError(null)
					try {
						const value = await call(method, payload, abortRef.current?.signal)
						if (!mounted()) return null
						if (value !== null && typeof value === 'object') setSnapshot(value)
						return value ?? null
					} catch (cause) {
						if (mounted()) setError(describe(cause))
						return null
					} finally {
						if (mounted()) setBusy(false)
					}
				}, [])

				const changeMode = React.useCallback(
					async (next) => {
						if (next === snapshot?.mode) return
						setNotice(null)
						const value = await run('setMode', { mode: next })
						if (value !== null) setNotice(`已切换到「${MODE_LABEL[next] ?? next}」模式。`)
					},
					[run, snapshot]
				)

				const toggleShellEnv = React.useCallback(
					async (next) => {
						setNotice(null)
						const value = await run('settings', { injectShellEnv: next })
						if (value !== null) {
							setNotice(next ? '已把代理写入 Agent 的 shell 环境变量。' : '已停止向 Agent 的 shell 环境注入代理。')
						}
					},
					[run]
				)

				const restartCore = React.useCallback(async () => {
					setNotice(null)
					const value = await run('restart', {})
					if (value !== null) setNotice('已请求重启内核。')
				}, [run])

				const copyProxyUrl = React.useCallback(async () => {
					const url = typeof snapshot?.proxyUrl === 'string' ? snapshot.proxyUrl : ''
					if (url.length === 0) return
					setError(null)
					try {
						if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') {
							throw new Error('clipboard unavailable')
						}
						await globalThis.navigator.clipboard.writeText(url)
						setNotice(`已复制 ${url}`)
					} catch {
						selectText(proxyUrlRef.current)
						setNotice('浏览器不允许自动复制，已选中地址文本，请按 Ctrl+C 复制。')
					}
				}, [snapshot])

				const doImport = React.useCallback(async () => {
					const links = importText.trim()
					if (links.length === 0) {
						setError('请先粘贴至少一条分享链接。')
						return
					}
					const remark = importRemark.trim()
					setNotice(null)
					setImportReport(null)
					const value = await run('import', remark.length > 0 ? { links, remark } : { links })
					if (value === null) return
					const imported = Array.isArray(value.imported) ? value.imported : []
					const failed = Array.isArray(value.errors) ? value.errors : []
					setImportReport({ imported, errors: failed })
					if (imported.length > 0) {
						setImportText('')
						setImportRemark('')
					}
					setNotice(
						failed.length === 0
							? `已导入 ${imported.length} 个节点。`
							: `已导入 ${imported.length} 个节点，${failed.length} 行解析失败。`
					)
				}, [importText, importRemark, run])

				const addRoute = React.useCallback(async () => {
					const entry = normalizeRoute(routeDraft)
					if (entry.length === 0) return
					const current = Array.isArray(snapshot?.routes) ? snapshot.routes : []
					if (current.includes(entry)) {
						setError(`路由名单里已经有「${entry}」了。`)
						return
					}
					setNotice(null)
					const value = await run('settings', { routes: [...current, entry] })
					if (value !== null) {
						setRouteDraft('')
						setNotice(`已把 ${entry} 加入路由名单。`)
					}
				}, [routeDraft, run, snapshot])

				const removeRoute = React.useCallback(
					async (entry) => {
						const current = Array.isArray(snapshot?.routes) ? snapshot.routes : []
						setNotice(null)
						const value = await run('settings', { routes: current.filter((item) => item !== entry) })
						if (value !== null) setNotice(`已从路由名单移除 ${entry}。`)
					},
					[run, snapshot]
				)

				const testAll = React.useCallback(async () => {
					setNotice(null)
					setTestingId('*')
					try {
						const value = await run('test', {})
						if (value === null) return
						const results = Array.isArray(value.results) ? value.results : []
						const ok = results.filter((item) => item.ok === true).length
						setNotice(results.length === 0 ? '没有可测试的节点。' : `测试完成：${ok} / ${results.length} 个节点可用。`)
					} finally {
						setTestingId(null)
					}
				}, [run])

				const testNode = React.useCallback(
					async (node) => {
						setNotice(null)
						setTestingId(node.id)
						try {
							const value = await run('test', { id: node.id })
							if (value === null) return
							const results = Array.isArray(value.results) ? value.results : []
							const result = results.find((item) => item.id === node.id) ?? null
							if (result?.ok === true) {
								setNotice(`「${node.remark}」连通，延迟 ${result.ms ?? '—'} ms。`)
							} else {
								setNotice(`「${node.remark}」测试失败${result?.error ? `：${result.error}` : '。'}`)
							}
						} finally {
							setTestingId(null)
						}
					},
					[run]
				)

				/** Download the bundled core from the release, then re-read the snapshot. */
				const installCore = React.useCallback(async () => {
					setCoreInstalling(true)
					setError(null)
					setNotice(null)
					try {
						const value = await call('installCore', {})
						setSnapshot(value)
						setNotice(`内核已就绪（${value.installed?.asset ?? 'sing-box'}）。`)
					} catch (cause) {
						setError(`${describe(cause)} —— 可用「镜像地址」指向可访问的副本，或手动下载后放到 ${snapshot?.core?.expectedBinary ?? '插件的 bin 目录'}`)
					} finally {
						setCoreInstalling(false)
					}
				}, [snapshot])

				const cleanFailed = React.useCallback(async () => {
					const candidates = (snapshot?.nodes ?? []).filter(
						(node) => node.lastTest !== null && node.lastTest.ok === false && node.lastTest.local !== true
					).length
					const question =
						candidates > 0
							? `删除 ${candidates} 个已标记「失效」的节点？只有确实失败过的节点会在这里；本机限制（例如没有 IPv6 出口）造成的失败标为「本机不可用」，不会被删除，此操作无法撤销。`
							: '删除所有已标记「失效」的节点？「本机不可用」的节点不算失效，不会被删除，此操作无法撤销。'
					if (!globalThis.confirm(question)) return
					setNotice(null)
					const value = await run('clean', {})
					if (value !== null) setNotice(`已删除 ${value.removed ?? 0} 个失效节点。`)
				}, [run, snapshot])

				const selectNode = React.useCallback(
					async (node) => {
						setNotice(null)
						const value = await run('select', { id: node.id })
						if (value !== null) setNotice(`已选用「${node.remark}」。`)
					},
					[run]
				)

				const selectAuto = React.useCallback(async () => {
					setNotice(null)
					const value = await run('select', { id: null })
					if (value !== null) setNotice('已改为自动挑选最快的可用节点。')
				}, [run])

				const saveEdit = React.useCallback(async () => {
					if (editingId === null) return
					const remark = editingRemark.trim()
					if (remark.length === 0) {
						setError('节点备注不能为空。')
						return
					}
					setNotice(null)
					const value = await run('update', { id: editingId, remark })
					if (value !== null) {
						setEditingId(null)
						setEditingRemark('')
						setNotice(`已保存备注「${remark}」。`)
					}
				}, [editingId, editingRemark, run])

				const cancelEdit = React.useCallback(() => {
					setEditingId(null)
					setEditingRemark('')
				}, [])

				const startEdit = React.useCallback((node) => {
					setEditingId(node.id)
					setEditingRemark(node.remark)
					setError(null)
					setNotice(null)
				}, [])

				const removeNode = React.useCallback(
					async (node) => {
						if (!globalThis.confirm(`删除节点「${node.remark}」？此操作无法撤销。`)) return
						setNotice(null)
						const value = await run('remove', { id: node.id })
						if (value !== null) {
							setNotice(`已删除「${node.remark}」。`)
							setEditingId((current) => (current === node.id ? null : current))
						}
					},
					[run]
				)

				const message = (style, text) => (text === null ? null : h('p', { style }, text))

				/** One node card; `key` is attached here for the list map. */
				const renderNode = (node) => {
					const meta = STATUS_META[node.status] ?? STATUS_META.unknown
					const lastTest = node.lastTest ?? null
					const active = node.id === selectedId
					const editing = editingId === node.id
					return h(
						'div',
						{ key: node.id, style: { ...styles.nodeCard, ...(active ? styles.nodeCardActive : {}) } },
						h(
							'div',
							{ style: styles.nodeBody },
							editing
								? h(
										'div',
										{ style: styles.bar },
										h('input', {
											className: 'dshnp-field',
											style: styles.remarkField,
											value: editingRemark,
											maxLength: MAX_REMARK,
											placeholder: '节点备注',
											onChange: (event) => setEditingRemark(event.target.value),
											onKeyDown: (event) => {
												if (event.key === 'Enter') {
													event.preventDefault()
													saveEdit()
												}
											}
										}),
										h(
											ui.Button,
											{
												variant: 'primary',
												size: 'sm',
												icon: h(ui.IconCheckOutlineRegular, { size: 16 }),
												disabled: busy,
												onClick: saveEdit
											},
											'保存'
										),
										h(
											ui.Button,
											{
												variant: 'ghost',
												size: 'sm',
												icon: h(ui.IconCloseOutlineRegular, { size: 16 }),
												disabled: busy,
												onClick: cancelEdit
											},
											'取消'
										)
									)
								: h(
										'div',
										{ style: styles.nodeName },
										node.remark,
										active ? h(ui.Tag, { tone: 'solid' }, '使用中') : null
									),
							h(
								'div',
								{ style: styles.nodeMeta },
								h(ui.Tag, { tone: 'outline' }, node.protocol),
								h('span', { style: styles.mono }, `${node.server}:${node.port}`),
								h(ui.Tag, { tone: meta.tone }, meta.label),
								// Only worth flagging when this machine could not use it anyway.
								node.ipv6Only === true && snapshot?.localIpv6 === false
									? h(ui.Tag, { tone: 'warning' }, 'IPv6 单栈')
									: null,
								h(
									'span',
									{ style: styles.hint },
									lastTest === null
										? '未测过'
										: `${lastTest.ok === true ? `${lastTest.ms ?? '—'} ms` : '上次失败'} · ${formatTime(lastTest.at)}`
								)
							),
							lastTest !== null && lastTest.ok !== true && typeof lastTest.error === 'string' && lastTest.error.length > 0
								? h('p', { style: styles.errorLine, title: lastTest.error }, truncate(lastTest.error, ERROR_PREVIEW))
								: null,
							h('p', { className: 'dshnp-link', style: styles.link, title: node.link }, truncate(node.link, LINK_PREVIEW))
						),
						h(
							'div',
							{ style: styles.nodeActions },
							active
								? null
								: h(
										ui.Button,
										{
											variant: 'outline',
											size: 'sm',
											icon: h(ui.IconCheckOutlineRegular, { size: 16 }),
											disabled: busy,
											onClick: () => selectNode(node)
										},
										'选用'
									),
							h(
								ui.Button,
								{
									variant: 'ghost',
									size: 'sm',
									icon: h(ui.IconGaugeOutlineRegular, { size: 16 }),
									disabled: busy,
									onClick: () => testNode(node)
								},
								testingId === node.id ? '测试中…' : '测试'
							),
							h(
								ui.Button,
								{
									variant: 'ghost',
									size: 'sm',
									icon: h(ui.IconEditOutlineRegular, { size: 16 }),
									disabled: busy,
									onClick: () => startEdit(node)
								},
								'编辑'
							),
							h(
								ui.Button,
								{
									variant: 'ghost',
									size: 'sm',
									icon: h(ui.IconTrashOutlineRegular, { size: 16 }),
									disabled: busy,
									onClick: () => removeNode(node)
								},
								'删除'
							)
						)
					)
				}

				return h(
					'div',
					{ style: styles.root },
					h(
						'p',
						{ style: styles.lede },
						'这是给 Agent 用的按需网络代理：节点在你自己的机器上跑，只有需要时才走。选择「智能」时，下面名单里的站点走节点、其余流量直连，直连失败会自动回退到节点，所以 Agent 访问 GitHub、pip、npm 时不必手动切代理。'
					),
					message(styles.error, error),
					message(styles.ok, notice),

					h(
						'div',
						{ style: styles.panel },
						h(
							'div',
							{ style: styles.statusRow },
							h('span', { style: styles.statusItem }, h(ui.StateDot, { state: coreDot }), coreText),
							core !== null && typeof core.version === 'string' && core.version.length > 0
								? h(ui.Tag, { tone: 'neutral' }, `sing-box ${core.version}`)
								: null,
							core !== null && core.installed === false ? h(ui.Tag, { tone: 'warning' }, '内核未安装') : null,
							snapshot !== null ? h(ui.Tag, { tone: 'info' }, `模式：${MODE_LABEL[mode] ?? mode}`) : null,
							h('span', { style: styles.spacer }),
							core !== null && core.installed === false
								? h(
										ui.Button,
										{
											variant: 'primary',
											size: 'sm',
											icon: h(ui.IconDownloadOutlineRegular, { size: 16 }),
											disabled: busy || snapshot === null,
											onClick: installCore
										},
										coreInstalling ? '下载中…' : '下载内核'
									)
								: null,
							h(
								ui.Button,
								{
									variant: 'ghost',
									size: 'sm',
									icon: h(ui.IconRefreshOutlineRegular, { size: 16 }),
									disabled: busy || snapshot === null || (core !== null && core.installed === false),
									onClick: restartCore
								},
								'重启内核'
							)
						),
						core !== null && core.installed === false
							? h(
									'p',
									{ style: styles.warn },
									`内核还没有下载（本平台：${core.platform ?? '未知'}${core.asset ? ` · 文件 ${core.asset}` : ' · 该平台暂无预编译内核'}）。点「下载内核」会自动从 Release 附件下载并校验 SHA-256；如果本机访问 GitHub 受限，可以先用别的方式下载${core.downloadUrl ? ` ${core.downloadUrl}` : ''}，放到 ${core.expectedBinary ?? '插件的 bin 目录'} 即可被识别。`
								)
							: null,
						core !== null && core.installed === false
							? h(
									'div',
									{ style: styles.bar },
									h('input', {
										className: 'dshnp-field',
										style: { flex: '1 1 260px' },
										value: mirrorDraft,
										placeholder: '镜像地址（可选）：把内核下载指向你自己的镜像或代理',
										onChange: (event) => setMirrorDraft(event.target.value)
									}),
									h(
										ui.Button,
										{
											variant: 'outline',
											size: 'sm',
											disabled: busy || snapshot === null || mirrorDraft === (core.mirror ?? ''),
											onClick: () => run('settings', { coreMirror: mirrorDraft }, '镜像地址已保存。')
										},
										'保存镜像'
									)
								)
							: null,
						core !== null && typeof core.error === 'string' && core.error.length > 0
							? h('p', { style: styles.error }, `内核错误：${core.error}`)
							: null,
						h(
							'p',
							{ style: styles.hint },
							`当前节点：${selectedNode !== null ? selectedNode.remark : '自动（挑最快的可用节点）'}`
						),
						snapshot !== null &&
						typeof snapshot.mixedPort === 'number' &&
						typeof snapshot.clashPort === 'number' &&
						typeof snapshot.routerPort === 'number'
							? h(
									'p',
									{ style: styles.hint },
									`本地端口：混合 ${snapshot.mixedPort} · Clash ${snapshot.clashPort} · 路由 ${snapshot.routerPort}`
								)
							: null,
						// The IPv6 warning is only meaningful when the library actually holds
						// nodes this machine cannot reach: a deployment with no IPv6 egress
						// and only IPv4 nodes must not be told about IPv6 at all.
						snapshot !== null && snapshot.localIpv6 === false && ipv6NodeCount > 0
							? h(
									'p',
									{ style: styles.warn },
									`提示：本机没有全局 IPv6 出口，下面 ${ipv6NodeCount} 个 IPv6 单栈节点会连不通（已单独标注，测试与调用都会跳过它们，不会删除）。建议改用 IPv4 或双栈节点。`
								)
							: null
					),

					h(
						'div',
						{ style: styles.panel },
						h('span', { style: styles.label }, '代理模式'),
						h(ui.SegmentedControl, {
							id: 'dsh-net-proxy-mode',
							value: mode,
							options: MODE_OPTIONS,
							onChange: changeMode,
							label: '代理模式',
							disabled: busy || snapshot === null
						}),
						h(
							'p',
							{ style: styles.hint },
							'关闭：所有流量直连。智能：名单内站点走节点，其余直连且失败时自动回退。全局：所有流量都走节点。'
						),
						h(
							'div',
							{ style: styles.switchRow },
							h(ui.Switch, {
								checked: snapshot?.injectShellEnv === true,
								onChange: toggleShellEnv,
								label: '把代理写入 Agent 的 shell 环境变量',
								disabled: busy || snapshot === null
							}),
							h(
								'div',
								{ style: styles.switchText },
								h('span', { style: styles.switchTitle }, '把代理写入 Agent 的 shell 环境变量'),
								h(
									'span',
									{ style: styles.hint },
									'开启后 Agent 执行的 curl / git / pip 会自动带上代理，不用每条命令都写 -x；模式为「关闭」时不会生效。'
								)
							)
						)
					),

					h(
						'div',
						{ style: styles.panel },
						h('span', { style: styles.label }, '本地代理地址'),
						h(
							'div',
							{ style: styles.urlRow },
							h('code', { ref: proxyUrlRef, style: styles.mono }, proxyUrl.length > 0 ? proxyUrl : '（内核还没起来）'),
							h(
								ui.Button,
								{
									variant: 'outline',
									size: 'sm',
									icon: h(ui.IconCopyOutlineRegular, { size: 16 }),
									disabled: proxyUrl.length === 0,
									onClick: copyProxyUrl
								},
								'复制'
							)
						),
						h('p', { style: styles.hint }, `用法示例：curl -x ${exampleUrl} https://github.com`),
						h('p', { style: styles.hint }, 'curl -x、git 的 http.proxy、pip --proxy 都接受这个地址；也可以打开上面的开关让 Agent 自动继承。')
					),

					h(
						'div',
						{ style: styles.panel },
						h('span', { style: styles.label }, '导入节点'),
						h('textarea', {
							className: 'dshnp-textarea',
							value: importText,
							placeholder: LINK_PLACEHOLDER,
							spellCheck: false,
							onChange: (event) => setImportText(event.target.value)
						}),
						h(
							'div',
							{ style: styles.bar },
							h('input', {
								className: 'dshnp-field',
								style: styles.remarkField,
								value: importRemark,
								maxLength: MAX_REMARK,
								placeholder: '备注（可选，留空则用链接里的 # 片段）',
								onChange: (event) => setImportRemark(event.target.value)
							}),
							h(
								ui.Button,
								{
									variant: 'primary',
									icon: h(ui.IconPlusOutlineRegular, { size: 16 }),
									disabled: busy,
									onClick: doImport
								},
								busy ? '导入中…' : '导入'
							)
						),
						h('p', { style: styles.hint }, '每行一条分享链接，支持 vless:// vmess:// trojan:// ss://；解析失败的行会逐条列出原因。'),
						importReport !== null && importReport.imported.length > 0
							? h(
									'p',
									{ style: styles.ok },
									`已导入 ${importReport.imported.length} 个节点：${importReport.imported
										.slice(0, 5)
										.map(
											(item) =>
												`${item.remark}（${item.protocol} ${item.server}:${item.port}）`
										)
										.join('、')}${importReport.imported.length > 5 ? ` 等 ${importReport.imported.length} 个` : ''}`
								)
							: null,
						importReport !== null && importReport.errors.length > 0
							? h(
									'div',
									{ style: styles.bar },
									h('span', { style: styles.label }, `${importReport.errors.length} 行解析失败：`),
									h(
										'div',
										{ style: styles.list },
										importReport.errors.map((item, index) =>
											h(
												'p',
												{ key: `${item.line}-${index}`, style: styles.errorLine },
												`第 ${item.line} 行：${item.message}`
											)
										)
									)
								)
							: null
					),

					h(
						'div',
						{ style: styles.panel },
						h('span', { style: styles.label }, `智能模式路由名单（${routes.length}）`),
						h('p', { style: styles.hint }, '名单里写域名后缀：命中它的请求走节点，其余直连；直连失败时会自动回退到节点。'),
						h(
							'div',
							{ style: styles.chipRow },
							routes.length === 0
								? h('span', { style: styles.hint }, '名单为空：智能模式下所有流量都先尝试直连。')
								: routes.map((entry) =>
										h(
											'span',
											{ key: entry, style: styles.chip },
											h('span', { style: styles.chipText }, entry),
											h(
												'button',
												{
													type: 'button',
													style: styles.chipRemove,
													title: `移除 ${entry}`,
													'aria-label': `移除 ${entry}`,
													disabled: busy,
													onClick: () => removeRoute(entry)
												},
												'×'
											)
										)
									)
						),
						h(
							'div',
							{ style: styles.bar },
							h('input', {
								className: 'dshnp-field',
								style: styles.routeField,
								value: routeDraft,
								placeholder: '例如 github.com，回车添加',
								onChange: (event) => setRouteDraft(event.target.value),
								onKeyDown: (event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										addRoute()
									}
								}
							}),
							h(
								ui.Button,
								{
									variant: 'outline',
									size: 'sm',
									icon: h(ui.IconPlusOutlineRegular, { size: 16 }),
									disabled: busy,
									onClick: addRoute
								},
								'添加'
							)
						)
					),

					h(
						'div',
						{ style: styles.bar },
						h(
							ui.Button,
							{
								variant: 'outline',
								size: 'sm',
								icon: h(ui.IconGaugeOutlineRegular, { size: 16 }),
								disabled: busy || nodes.length === 0,
								onClick: testAll
							},
							testingId === '*' ? '测试中…' : '测试全部'
						),
						h(
							ui.Button,
							{
								variant: 'outline',
								size: 'sm',
								icon: h(ui.IconTrashOutlineRegular, { size: 16 }),
								disabled: busy || nodes.length === 0,
								onClick: cleanFailed
							},
							'删除失效节点'
						),
						selectedId !== null
							? h(
									ui.Button,
									{ variant: 'ghost', size: 'sm', disabled: busy, onClick: selectAuto },
									'改为自动挑选'
								)
							: null,
						h('span', { style: styles.spacer }),
						h('span', { style: styles.counter }, `${nodes.length} 个节点`)
					),

					snapshot === null && error === null ? h('div', { style: styles.empty }, '正在读取代理状态…') : null,
					snapshot !== null && nodes.length === 0
						? h(
								'div',
								{ style: styles.empty },
								'还没有节点。把机场的分享链接粘到上面的导入框里（每行一条），点「导入」就会出现在这里；导入后先「测试全部」，再挑一个延迟低的节点。'
							)
						: null,
					nodes.length > 0 ? h('div', { style: styles.list }, nodes.map(renderNode)) : null,

					snapshot !== null
						? h(
								'p',
								{ style: styles.footer },
								`内核：${snapshot.core?.binary ?? '—'}　配置文件：${snapshot.core?.configFile ?? '—'}　节点数据：${snapshot.dataFile ?? '—'}`
							)
						: null
				)
			}
		}

		/** Cordis plugin name for the client half. */
		const name = 'dsh-net-proxy-settings'
		/** Client services this panel needs: the settings slot registry and the RPC transport. */
		const inject = ['slots', 'connection']

		function apply(ctx) {
			const NetworkProxySection = createNetworkProxySection(ctx)
			ctx.effect(installStyles, 'dsh-net-proxy: settings styles')
			ctx.effect(
				() =>
					ctx.slots.inject('settings.section', () => {
						const unregister = ctx.slots.register(
							{
								name: 'settings.section',
								id: 'dsh-net-proxy',
								order: 50,
								label: () => '网络代理'
							},
							NetworkProxySection
						)
						return () => unregister()
					}),
				'dsh-net-proxy: settings section'
			)
		}

		return { name, inject, apply }
	}
})
