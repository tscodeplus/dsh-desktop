# DSH Desktop

> A community desktop build of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — **this project is a community desktop version built on DeepSeek Harness, not an official DeepSeek product.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/tscodeplus/deepseek-harness-desktop)](https://github.com/tscodeplus/deepseek-harness-desktop/releases)

**English** · [中文](README.zh-CN.md)

**DSH Desktop** packages the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) agent harness into a native desktop application for **Windows (x64)** and **macOS (Intel x64 + Apple Silicon arm64)**. It is built with **Tauri 2** and a **Node.js sidecar**, following a "shell + sidecar" architecture proven by [OhMyAgent](https://github.com/tscodeplus/OhMyAgent).

Instead of running `npx @deepseek-ai/dsh web` and keeping a terminal open, users get an install-and-go desktop app: the bundled runtime starts the local `dsh web` server, the WebView loads it at `http://127.0.0.1:3080`, and the tray icon, single-instance guard, and auto-updater handle the desktop experience.

## Disclaimer

This project is a **community desktop version built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** and is **not an official DeepSeek product**. All DeepSeek Harness functionality, plugins, and the Web UI come from the official open-source project (MIT licensed). If you want to run the harness from the command line or contribute to its core, please use the [official repository](https://github.com/deepseek-ai/deepseek-harness) instead.

## Features

- **Install & go** — bundled Node.js runtime + pre-built dsh closure; no Node.js install, no terminal. Install, add your API key, and start using it
- **Three platforms** — official installers for Windows x64, macOS Intel (x64), and macOS Apple Silicon (arm64), built automatically for every release
- **Auto-update** — checks GitHub Releases in-app; one-click install on Windows, opens the Releases page on unsigned macOS builds
- **Tauri 2 shell** — native, small, and fast; WebView2 on Windows, WKWebView on macOS
- **Local-only by design** — dsh serves `http://127.0.0.1:3080`, loaded same-origin with no remote gateway
- **Robust lifecycle** — the shell spawns the sidecar, which spawns `dsh web`; heartbeat + Job Object (Windows) guarantee no orphan processes on quit, crash, or uninstall
- **System tray & single instance** — minimize to tray, close-to-tray, auto-start options, duplicate-launch guard
- **Custom whale icon** — an original whale mark with its own white-disc composition; crisp taskbar/tray icons and dark-mode-aware injected title bar
- **Frameless, injected title bar** — no upstream source modification; drag region + minimize/maximize/close buttons overlay the page, theme-aware
- **Deterministic dependency following** — the app builds from the upstream git commit pinned in `desktop/dsh-ref.json` (single-mode git-follow, no fork, no patch conflicts)

## How it works

```
┌────────────────────────────────────────────────────────────┐
│  Tauri 2 shell (Rust)                                      │
│  window · tray · single-instance · autostart · Job Object │
└──────────────────────┬─────────────────────────────────────┘
                       │ spawns / supervises
┌──────────────────────▼─────────────────────────────────────┐
│  Node.js sidecar (bundled Node 24 runtime)                 │
│  spawns `dsh web` · readiness probe · control API          │
│  heartbeat · auto-updater                                  │
└──────────────────────┬─────────────────────────────────────┘
                       │ spawns
┌──────────────────────▼─────────────────────────────────────┐
│  dsh (DeepSeek Harness) at the pinned git ref              │
│  http://127.0.0.1:3080  (same-origin WebUI in the WebView) │
└────────────────────────────────────────────────────────────┘
```

Key decisions:

- **No fork, no upstream patches** — dsh is fetched and built at a pinned commit by `desktop/scripts/fetch-dsh.cjs`; bumping dsh is a single command and a regression test, never a merge
- **Bundled runtime + flattened closure** — the official Node runtime and a pruned, platform-matched `node_modules` closure ship inside the installer; wrong-architecture native binaries (node-pty, koffi, sharp) are pruned per target
- **Localhost-only security model** — dsh has no authentication layer; the app keeps it localhost-only by design and does not attempt remote access

## Installation

Download the latest installer from the [Releases](https://github.com/tscodeplus/deepseek-harness-desktop/releases) page:

| Platform | Artifact |
|---|---|
| Windows x64 | `DSH-Desktop-Setup-<version>.exe` (NSIS, LZMA) |
| macOS Intel | `DSH-Desktop-<version>.dmg` |
| macOS Apple Silicon | `DSH-Desktop-<version>-arm64.dmg` |

Notes:

- Windows: the installer bundles the WebView2 bootstrapper and installs for the current user; in-app updates download from GitHub Releases
- macOS: unsigned/ad-hoc signed (no paid certificate), so Gatekeeper will warn on first open — right-click → Open

## Development

### Prerequisites

- Node.js 24 (matches the bundled runtime; dsh requires `^22.19 || >=24`)
- pnpm 11
- Rust (MSVC toolchain on Windows, Xcode CLT on macOS)
- Tauri 2 system dependencies (WebView2 / WKWebView)

### Commands

```bash
pnpm install          # shell + sidecar dependencies
pnpm dev              # Tauri dev mode (dsh web on http://127.0.0.1:3080)
pnpm test             # unit tests (vitest)
pnpm lint             # TypeScript type check
```

`dsh` occupies port 3080. Kill stale processes before a dev run:

```bash
fuser -k 3080/tcp 2>/dev/null
pkill -f "dsh web" 2>/dev/null
```

### Building installers

Windows (PowerShell):

```powershell
cd desktop
.\scripts\build.ps1            # syncs from WSL → fetch dsh → bundle → NSIS
```

macOS / CI:

```bash
cd desktop
npx tauri build --bundles app   # .app; dmg is assembled with hdiutil in CI
```

The build is fully reproducible: `desktop/dsh-ref.json` pins the exact upstream commit, and CI caches the dsh closure, Node runtime, and cargo artifacts.

## Project layout

```
desktop/
  src-tauri/        # Rust shell (window, tray, single-instance, config)
  sidecar/          # Node sidecar TS (spawn dsh, control API, updater)
  scripts/          # fetch-dsh / fetch-node / bundle-deps / build.ps1 / release-meta
  dsh-ref.json      # pinned upstream ref (single-mode git-follow manifest)
  assets/           # icon sources
ui/                 # splash / error pages
.github/workflows/  # release matrix + upstream watcher
```

## Contributing

Contributions are welcome! Open an issue for bugs or feature requests, and submit pull requests for changes. Keep in mind:

- Do not modify upstream DeepSeek Harness source — dependency changes go through `dsh-ref.json`
- Keep `desktop/package.json` and `src-tauri/tauri.conf.json` versions in sync
- Make sure `pnpm test` passes before committing

## License

MIT — see [LICENSE](LICENSE). Third-party attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

DeepSeek Harness and the DeepSeek brand are trademarks of DeepSeek AI. This project is an independent community project and is not affiliated with, endorsed by, or sponsored by DeepSeek.
