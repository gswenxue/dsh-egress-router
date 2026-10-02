# Third-party notices

## sing-box (the proxy core)

This plugin does not contain a proxy core in its repository. Instead it downloads
an **unmodified upstream build** of sing-box from its own GitHub Release and
verifies the SHA-256 recorded in `lib/core-manifest.js`.

| | |
|---|---|
| Project | sing-box — https://github.com/SagerNet/sing-box |
| Version | 1.13.19 (tag [`v1.13.19`](https://github.com/SagerNet/sing-box/releases/tag/v1.13.19)) |
| Author | nekohasekai <contact-sagernet@sekai.icu> |
| License | GNU General Public License v3.0 or later, plus an additional upstream term |

### Assets redistributed by this project

| Asset | Upstream file |
|---|---|
| `sing-box-linux-amd64` | `sing-box-1.13.19-linux-amd64-musl.tar.gz` → `sing-box` |
| `sing-box-linux-arm64` | `sing-box-1.13.19-linux-arm64-musl.tar.gz` → `sing-box` |
| `sing-box-darwin-amd64` | `sing-box-1.13.19-darwin-amd64.tar.gz` → `sing-box` |
| `sing-box-darwin-arm64` | `sing-box-1.13.19-darwin-arm64.tar.gz` → `sing-box` |
| `sing-box-windows-amd64.exe` | `sing-box-1.13.19-windows-amd64.zip` → `sing-box.exe` |
| `libcronet-windows-amd64.dll` | `sing-box-1.13.19-windows-amd64.zip` → `libcronet.dll` |

The files are byte-identical to the upstream archives' contents; only the asset
names differ so that the download URL is derivable from `process.platform`.

### License text

```
Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <http://www.gnu.org/licenses/>.

In addition, no derivative work may use the name or imply association
with this application without prior consent.
```

The full license text ships with every downloaded archive (`LICENSE.sing-box` is
also uploaded as a release asset). Source code for the binaries is available at
the upstream repository and its `v1.13.19` tag.

## DeepSeek Harness

DeepSeek Harness is licensed by its own project; this plugin only uses its public
plugin API (`apply(ctx)`, `ctx.tools`, `ctx.connection.fetch`) and ships no
Harness code.
