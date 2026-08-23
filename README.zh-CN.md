# DSH Desktop

> 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的社区桌面版本 —— **本项目是基于 DeepSeek Harness 构建的社区桌面版本，并非 DeepSeek 官方产品。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/tscodeplus/deepseek-harness-desktop)](https://github.com/tscodeplus/deepseek-harness-desktop/releases)

[English](README.md) · **中文**

**DSH Desktop** 将官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）智能体框架封装为原生桌面应用，支持 **Windows (x64)** 与 **macOS（Intel x64 + Apple Silicon arm64）**。项目采用 **Tauri 2 + Node.js sidecar** 的「壳 + 副进程」架构（该架构参考了 [OhMyAgent](https://github.com/tscodeplus/OhMyAgent) 并已被验证成熟）。

用户无需执行 `npx @deepseek-ai/dsh web` 或长期开着终端：安装即用。应用内置运行时启动本地 `dsh web` 服务，WebView 以同源方式加载 `http://127.0.0.1:3080`，托盘图标、单实例保护和自动更新等桌面能力开箱即用。

## 免责声明

本项目是**基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的社区桌面版本**，**并非 DeepSeek 官方产品**。DeepSeek Harness 的核心能力、插件系统与 Web UI 均来自官方开源项目（MIT 协议）。如需通过命令行运行 Harness 或参与核心功能开发，请优先使用[官方仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 特性

- **开箱即用** —— 内置 Node.js 运行时与预构建的 dsh 闭包，无需安装 Node.js、无需命令行；安装后配置 API Key 即可使用
- **支持三平台** —— 每个版本自动构建 Windows x64、macOS Intel (x64)、macOS Apple Silicon (arm64) 三平台安装包
- **支持在线更新** —— 应用内自动检查 GitHub Releases 新版本；Windows 一键下载安装，macOS（未签名）引导打开 Releases 页面
- **Tauri 2 壳** —— 原生、轻量、启动快；Windows 使用 WebView2，macOS 使用 WKWebView
- **仅限本地** —— dsh 只监听 `http://127.0.0.1:3080`，同源加载，无远程网关
- **健壮的生命周期管理** —— 壳拉起 sidecar、sidecar 拉起 `dsh web`；心跳检测 + Windows Job Object 保证退出/崩溃/卸载后无孤儿进程
- **系统托盘 + 单实例** —— 最小化到托盘、关闭到托盘、开机自启、防重复启动
- **定制鲸鱼图标** —— 原创鲸鱼标识，白圆底构图独立设计；任务栏/托盘图标清晰，注入式标题栏支持深色模式
- **无边框 + 注入式标题栏** —— **不改上游源码**：拖拽区 + 最小化/最大化/关闭按钮悬浮覆盖页面，随主题变色
- **确定性依赖跟随** —— 构建产物与 `desktop/dsh-ref.json` 钉住的上游 commit 一一对应（单一模式 git-follow，无 fork、无补丁冲突）

## 工作原理

```
┌────────────────────────────────────────────────────────────┐
│  Tauri 2 壳（Rust）                                         │
│  窗口 · 托盘 · 单实例 · 开机自启 · Job Object                │
└──────────────────────┬─────────────────────────────────────┘
                       │ 拉起 / 守护
┌──────────────────────▼─────────────────────────────────────┐
│  Node.js sidecar（内置 Node 24 运行时）                     │
│  拉起 `dsh web` · 就绪探测 · 控制 API                       │
│  心跳 · 自动更新                                            │
└──────────────────────┬─────────────────────────────────────┘
                       │ 拉起
┌──────────────────────▼─────────────────────────────────────┐
│  dsh（DeepSeek Harness，钉住的上游 commit）                 │
│  http://127.0.0.1:3080（WebView 同源加载 WebUI）            │
└────────────────────────────────────────────────────────────┘
```

关键决策：

- **不 fork、不打上游补丁** —— `desktop/scripts/fetch-dsh.cjs` 在钉住的 commit 上抓取并构建 dsh；升级 dsh 是一条命令 + 一次回归测试，而不是一次合并
- **内置运行时 + 扁平化闭包** —— 安装包内携带官方 Node 运行时与裁剪后的、按平台匹配的 `node_modules` 闭包；node-pty / koffi / sharp 等原生二进制按目标平台裁剪
- **仅本地安全模型** —— dsh 本身无鉴权层；应用坚持仅本地监听，不做任何远程访问

## 安装

从 [Releases](https://github.com/tscodeplus/deepseek-harness-desktop/releases) 页面下载最新安装包：

| 平台 | 安装包 |
|---|---|
| Windows x64 | `DSH-Desktop-Setup-<版本>.exe`（NSIS，LZMA 压缩） |
| macOS Intel | `DSH-Desktop-<版本>.dmg` |
| macOS Apple Silicon | `DSH-Desktop-<版本>-arm64.dmg` |

说明：

- Windows：安装包自带 WebView2 引导程序，按当前用户安装；应用内更新从 GitHub Releases 下载
- macOS：无付费证书（ad-hoc 签名），首次打开 Gatekeeper 会提示 —— 右键 → 打开即可

## 开发

### 前置条件

- Node.js 24（与内置运行时一致；dsh 要求 `^22.19 || >=24`）
- pnpm 11
- Rust（Windows 用 MSVC 工具链，macOS 用 Xcode CLT）
- Tauri 2 系统依赖（WebView2 / WKWebView）

### 常用命令

```bash
pnpm install          # 安装壳 + sidecar 依赖
pnpm dev              # Tauri 开发模式（dsh web 运行在 http://127.0.0.1:3080）
pnpm test             # 单元测试（vitest）
pnpm lint             # TypeScript 类型检查
```

`dsh` 默认占用 3080 端口，开发前先清理残留进程：

```bash
fuser -k 3080/tcp 2>/dev/null
pkill -f "dsh web" 2>/dev/null
```

### 构建安装包

Windows（PowerShell）：

```powershell
cd desktop
.\scripts\build.ps1            # 从 WSL 同步 → fetch dsh → bundle → NSIS
```

macOS / CI：

```bash
cd desktop
npx tauri build --bundles app   # 产出 .app；dmg 在 CI 中用 hdiutil 组装
```

构建完全可复现：`desktop/dsh-ref.json` 钉住上游 commit，CI 对 dsh 闭包、Node 运行时与 cargo 产物做了缓存。

## 目录结构

```
desktop/
  src-tauri/        # Rust 壳（窗口、托盘、单实例、配置）
  sidecar/          # Node sidecar TS（拉起 dsh、控制 API、更新器）
  scripts/          # fetch-dsh / fetch-node / bundle-deps / build.ps1 / release-meta
  dsh-ref.json      # 钉住的上游 ref（单一模式 git-follow 清单）
  assets/           # 图标源文件
ui/                 # splash / error 页面
.github/workflows/  # 发布矩阵 + 上游监视
```

## 贡献

欢迎贡献！有问题或功能建议请开 Issue，改动请提交 Pull Request。请遵守：

- 不修改上游 DeepSeek Harness 源码 —— 依赖变更一律通过 `dsh-ref.json`
- 保持 `desktop/package.json` 与 `src-tauri/tauri.conf.json` 版本一致
- 提交前确保 `pnpm test` 通过

## 许可证

MIT —— 见 [LICENSE](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

DeepSeek Harness 与 DeepSeek 品牌商标归 DeepSeek AI 所有。本项目是独立的社区项目，与 DeepSeek 无隶属、背书或赞助关系。
