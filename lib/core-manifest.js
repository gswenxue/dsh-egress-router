/**
 * Which sing-box build this plugin downloads, and from where.
 *
 * The core is deliberately NOT in the repository: it is ~50-65 MB per platform,
 * which would bloat every clone. It ships as GitHub Release assets instead, and
 * `lib/core.js` fetches the one this machine needs, verifying the SHA-256 below
 * before it is made executable.
 *
 * Regenerating this file: upload the assets to the release named in
 * {@link CORE.releaseBase}, then paste each `sha256sum` output here. The asset
 * names are the upstream `sing-box-<version>-<os>-<arch>` binaries, renamed to
 * `<os>-<arch>` so the download URL is derivable from `process.platform`.
 *
 * @module dsh-egress-router/core-manifest
 */

/** The pinned core release. */
export const CORE = {
	version: '1.13.19',
	/** Release the assets live in; `<releaseBase>/<asset name>` is the download URL. */
	releaseBase: 'https://github.com/gswenxue/dsh-egress-router/releases/download/v0.1.0',
	/** Upstream project the binaries are built from, unmodified. */
	upstream: 'https://github.com/SagerNet/sing-box',
	assets: {
		'linux-x64': {
			name: 'sing-box-linux-amd64',
			sha256: '031042edfd30a215e4c69d83eb7d13c194e6ef50c782e2e1308d9d8fa128454a',
			note: 'upstream linux-amd64-musl build: statically linked, runs on glibc and musl'
		},
		'linux-arm64': {
			name: 'sing-box-linux-arm64',
			sha256: 'be2fa4159ff5ed892591f529c861cc3d3571adea8936b37287b7e2d8c03daf6a',
			note: 'upstream linux-arm64-musl build: statically linked'
		},
		'darwin-x64': {
			name: 'sing-box-darwin-amd64',
			sha256: '078164e43464f2282ae526151411320582c3e60a0294cec24a627edf205305a6',
			note: 'upstream darwin-amd64 build'
		},
		'darwin-arm64': {
			name: 'sing-box-darwin-arm64',
			sha256: '5b75c1dec19488675f725adc7a6e3a7301a553117af835dc47669b1fa918976b',
			note: 'upstream darwin-arm64 build (Apple silicon)'
		},
		'win32-x64': {
			name: 'sing-box-windows-amd64.exe',
			sha256: 'a4476dd768168a77e249050066bb32774addefcc37da123978623e7b2819de28',
			note: 'upstream windows-amd64 build',
			/** The upstream Windows build loads this DLL through cgo; fetched alongside the exe. */
			extra: {
				name: 'libcronet-windows-amd64.dll',
				sha256: '257f966119ffca91d7a2ce110a4b668b865d88bf2ed5339fd06a5644b0d02823'
			}
		}
	}
}

/**
 * The manifest key for a platform/arch pair.
 * @param platform - `process.platform` unless a caller overrides it.
 * @param arch - `process.arch` unless a caller overrides it.
 * @returns the key, or `undefined` when this plugin has no build for it.
 */
export function platformKey(platform = process.platform, arch = process.arch) {
	if (platform === 'linux') return arch === 'x64' ? 'linux-x64' : arch === 'arm64' ? 'linux-arm64' : undefined
	if (platform === 'darwin') return arch === 'x64' ? 'darwin-x64' : arch === 'arm64' ? 'darwin-arm64' : undefined
	if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : undefined
	return undefined
}

/** The executable's file name on this platform. */
export function coreFileName(platform = process.platform) {
	return platform === 'win32' ? 'sing-box.exe' : 'sing-box'
}
