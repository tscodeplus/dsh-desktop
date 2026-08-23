# Third-Party Notices

DSH Desktop builds on the following open-source projects. Their
licenses are reproduced or linked below; per MIT terms, the copyright notices
of substantial code contributions are preserved here.

## DeepSeek Harness (upstream project)

- Project: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT, Copyright (c) 2026 DeepSeek

The desktop app fetches and builds the upstream repository at the commit
pinned in `desktop/dsh-ref.json`. No upstream source code is modified; the
upstream source is not vendored into this repository.

## OhMyAgent (desktop template)

- Project: <https://github.com/tscodeplus/OhMyAgent>
- License: MIT, Copyright (c) 2025 OhMyAgent Contributors

The Tauri shell, Node sidecar, and build scripts in `desktop/` were initially
adapted from the OhMyAgent desktop template and have since diverged
substantially (window management, sidecar lifecycle, dependency following,
packaging, updater, and iconography).

## Tauri

- Project: <https://github.com/tauri-apps/tauri>
- License: MIT OR Apache-2.0

## Node.js (bundled runtime)

- Project: <https://nodejs.org>
- License: Node.js license (MIT-style, see <https://raw.githubusercontent.com/nodejs/node/main/LICENSE>)

## Other dependencies

All npm packages bundled into the installer carry their own licenses in their
respective package metadata; see the `license` field of each package in
`desktop/.sidecar-deps/node_modules` (generated during the build) or the
upstream DeepSeek Harness `THIRD_PARTY_NOTICES.md` for the full dependency
license disclosure of the dsh closure.
