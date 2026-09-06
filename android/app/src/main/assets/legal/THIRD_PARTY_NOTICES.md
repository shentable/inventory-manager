# Third-party notices

飨拓™库存管理 includes or interoperates with third-party software. Those
components are not relicensed under the project’s AGPL-3.0-only license.

## EasyTier

- Project: EasyTier
- Upstream: https://github.com/EasyTier/EasyTier
- Version used by the Android build: `v2.6.4`
- Upstream commit: `8428a89d2dabc94c97d370ec607c6ca142473626`
- License: GNU Lesser General Public License, version 3
- Local license copies: `LICENSES/LGPL-3.0-only.txt` and
  `LICENSES/GPL-3.0-only.txt`
- Corresponding source: https://github.com/EasyTier/EasyTier/tree/v2.6.4

The Android package launches the unmodified `easytier-core` executable as a
separate child process. `android/easytier/build-core.sh` fetches the pinned tag,
builds it for arm64 Android, and records the resolved commit and binary SHA-256.
If EasyTier is modified, the modified corresponding source and build material
must be supplied under its license.

When distributing an APK, keep this notice and both GNU license texts in the
package. Do not remove the reverse-engineering and relinking rights required by
the LGPL.

## SQLite

The native backend uses SQLite through `rusqlite` with the bundled SQLite
feature. SQLite is dedicated to the public domain by its upstream authors:
https://www.sqlite.org/copyright.html

## Caddy

The documented VPS deployment uses Caddy as a separately installed reverse
proxy. Caddy is not part of this repository’s binaries and remains subject to
its own Apache-2.0 license: https://github.com/caddyserver/caddy

## Package dependencies

Rust, Python, JavaScript, Kotlin, and Android dependencies retain the licenses
declared by their upstream projects. Exact versions are recorded in
`native-server/Cargo.lock`, `server/requirements.txt`, `package-lock.json`, and
the Android Gradle version catalog. A distributor is responsible for retaining
all notices required by the exact dependency set included in its build.
