/**
 * bundle-deps.cjs — Prepare flat node_modules for the Tauri sidecar.
 *
 * Problem: pnpm's node_modules uses symlinks to a content-addressable store
 * (.pnpm/<name>@<ver>/node_modules/<name>/). Bundled verbatim, those .pnpm/*
 * paths would break Node.js module resolution at runtime.
 *
 * Solution:
 *   1. Walk pnpm's dependency tree to get every package's actual path
 *   2. Copy each package into a flat staging node_modules/
 *   3. Prune dev-only packages and wrong-platform native binaries
 *
 * Usage: node scripts/bundle-deps.cjs
 * Run from: desktop/ directory
 */

const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DESKTOP = path.resolve(__dirname, '..');
// dsh build closure (fetched + built by fetch-dsh.cjs at the pinned ref).
const ROOT = path.join(DESKTOP, '.dsh-build', 'dist');
const STAGING = path.join(DESKTOP, '.sidecar-deps');
const STAGING_NM = path.join(STAGING, 'node_modules');
const DSH_REF_FILE = path.join(DESKTOP, 'dsh-ref.json');
const BUNDLE_MANIFEST_FILE = path.join(STAGING, 'bundle-manifest.json');
// Bump when the flattening logic changes so the fast path rebuilds stale
// staging (v2: workspace members added; v3: rolldown skip + node-pty
// prebuild pruning + leaner dsh runtime closure; v4: keep node-pty build/
// for Linux node-gyp fallback; v5: prune the dependency subtree of skipped
// dev-only packages so jsdom/vitest/istanbul chains never reach staging;
// v6: keep @img/sharp-libvips-<os>-<arch> on macOS/Linux (sharp 0.35+ loads
// libvips from the separate package; pruned only on Windows);
// v7: prune the dsh demo/examples umbrella (see v8 note);
// v8: keep the optional external subagent driver packages (claude-code /
// codex / acp / dsh-sdk — they resolve the user's own CLI from PATH) but
// prune ONLY the @anthropic-ai/claude-agent-sdk per-platform native binary
// (~260 MB): dsh always passes pathToClaudeCodeExecutable resolved from PATH,
// so the SDK's bundled binary is dead weight;
// v9: keep the full @deepseek-ai/dsh-sdk* family (client/protocol/jsonrpc),
// including the jsonrpc demo package (tiny; kept for parity with upstream).
// v10: fast path also fingerprints pnpm-lock.yaml — adding a prod dependency
// (e.g. marked for release-notes rendering) used to keep the stale staging
// and ship a bundle whose sidecar crashed at import time with
// "Cannot find package '<new-dep>'".
// v11: prune @openai/codex (main + per-platform ~354 MB vendor binaries — the
// v0.4.0 installer grew 50 MB → 135 MB because of it) and inject a tiny
// PATH-forwarding stub under the same name so the dsh-subagent-codex driver's
// package-local resolution keeps working with the user's own `npm i -g
// @openai/codex`. Same-name version conflicts (main pkg vs its
// -win32-x64 platform variant) now prefer the plain-semver package instead of
// letting the variant overwrite it (which stripped bin.codex and crashed the
// driver at import).
const BUNDLE_DEPS_VERSION = 11;
// Mirrors every log line to .sidecar-deps/bundle.log so build.ps1 (which
// buffers cmd output until the command exits) can be tailed for progress.
const LOG_FILE = path.join(STAGING, 'bundle.log');
// Pruned dsh runtime closure (dsh-dist minus node_modules). The raw
// .dsh-build/dist embeds pnpm's .pnpm virtual store — tauri-build walks
// every resource file and its junction tree (49k+ rerun-if-changed lines,
// stack overflow, hundreds of MB of duplicate deps). Dependencies resolve
// from the flat staging node_modules instead.
const DSH_DIST_SRC = path.join(DESKTOP, '.dsh-build', 'dist');
const DSH_RUNTIME_DIST = path.join(STAGING, 'dsh-dist');

// Native .node addons that must be present (and Node-ABI) in the staging tree.
// dsh's native set: node-pty (PTY/ConPTY), koffi (Windows FFI), sharp
// (attachments), node-addon-require-builtin (custom loader). All ship plain
// Node prebuilds (from pnpm install on the build machine) matching the bundled
// Node runtime major version — no electron-rebuild step.
// koffi and node-addon-require-builtin ship their binaries in separate
// per-platform npm packages (@koromix/koffi-<os>-<arch> /
// node-addon-require-builtin-<os>-<arch>-<libc>), so the verification below
// resolves those variants too.
const NATIVE_ADDONS = [
  'node-pty',
  'koffi',
  'sharp',
  'node-addon-require-builtin',
];

/** Recursively find native binaries (.node / .so / .dll / .dylib) under a directory. */
function findNativeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/(\.node|\.so|\.dll|\.dylib)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// Patterns to skip — dev-only files that bloat the package
const SKIP_PATTERNS = [
  /\.d\.ts$/,           // TypeScript declarations
  /\.map$/,             // source maps
  /\.pdb$/,             // Windows debug symbols (PDB) — dev-only
  /\.ts$/,              // TypeScript sources (except .d.ts above)
  /^docs?\//,           // documentation dirs
  /^examples?\//,       // example dirs
  /^tests?\//,          // test dirs
  /^__tests__\//,       // jest test dirs
  /^\.git/,             // git metadata
  /^\.github\//,        // github configs
  /^\.npmignore/,       // npm metadata
  /^\.eslintrc/,        // lint configs
  /^benchmarks?\//,     // benchmark dirs
  /^Makefile/,          // build files
  /^CMakeLists\.txt/,   // cmake files
  /^binding\.gyp/,      // node-gyp files
  /\.mdx?$/,            // markdown files
  /^LICEN[S]E/,         // license files
  /^CHANGELOG/i,        // changelog files
  /^CODE_OF_CONDUCT/i,  // code of conduct
  /^SECURITY\.md/i,     // security policy
  /^CONTRIBUTING/i,     // contributing guides
  /^\.prettierrc/,      // prettier config
  /^\.circleci\//,      // CI config
  /^\.github\//,        // github templates
  /\.cc?$/,             // C/C++ source (only needed for node-gyp)
  /\.cpp$/,             // C++ source
  /\.c$/,               // C source
  /\.h(pp)?$/,          // C/C++ headers
  // Browser-only builds: Node's exports/main resolution never activates the
  // "browser" condition, and the packages below were verified to not use a
  // browser file as main. See PACKAGE_SUBPATH_SKIPS for package-scoped cuts.
  /^browser\.js$/,
  /^browser\.mjs$/,
  /^browser\.cjs$/,
  /^browser\//,
  // NOTE: Do NOT add a blanket /^deps\// rule here.
  // Some packages (e.g. @fastify/busboy) vendor runtime JS inside deps/
  // (like deps/dicer/). Skipping deps/ would break those at runtime.
  // C/C++ sources inside deps/ are already caught by the extension rules below.
];

// Well-known dev-only packages that should NEVER appear in production bundles.
// These can get pulled in via peer dependencies (e.g. i18next → typescript)
// even when using pnpm list --prod.
const SKIP_PACKAGES = new Set([
  'typescript',
  'tsx',
  'tsc-alias',
  'vite',
  'vitest',
  // Dev toolchains that leak into `pnpm list --prod` in workspace mode
  // (pnpm v10/11 does not filter workspace members' devDependencies).
  'esbuild',
  'lightningcss',
  'jsdom',
  'chai',
  'postcss',
  'openapi-typescript-helpers',
  'vite-tsconfig-paths',
  'rolldown',
  '@rolldown/pluginutils',
  'tailwindcss',
  '@tailwindcss/vite',
  '@vitejs/plugin-react',
  '@vitejs/plugin-vue',
  '@vitest/coverage-v8',
  '@vitest/expect',
  '@vitest/mocker',
  '@vitest/pretty-format',
  '@vitest/runner',
  '@vitest/snapshot',
  '@vitest/spy',
  '@vitest/utils',
  '@testing-library/dom',
  '@testing-library/react',
  'eslint',
  'prettier',
  '@types/node',
  // WASM fallback runtimes — only needed when native .node binaries are
  // unavailable. On Windows x64 (our target), all native addons compile
  // and work fine, making these dead weight.
  '@emnapi/core',
  '@emnapi/runtime',
  '@napi-rs/wasm-runtime',
  '@tybys/wasm-util',
  // Build-time C++ headers — required for node-gyp compilation only.
  // Not needed at runtime once native modules are compiled.
  'node-addon-api',
  // dsh demo/example packages — dev content, never part of the runtime
  // plugin tree. dsh-examples is an umbrella that also pulls the external
  // subagent backends (the drivers themselves ARE kept — see below).
  'dsh-examples',
  'dsh-jsonrpc-agent-pkg', // JSON-RPC spine demo deploy root (dep-only manifest)
  '@deepseek-ai/dsh-acp-demo',
  '@deepseek-ai/dsh-agent-spine-demo',
  // @anthropic-ai/claude-agent-sdk per-platform native binary packages: each
  // ships a ~260 MB claude CLI binary — the single largest item in the
  // bundle. The JS SDK (@anthropic-ai/claude-agent-sdk) IS kept: dsh's
  // subagent-claude-code driver resolves `claude` from PATH and passes it as
  // pathToClaudeCodeExecutable, so the SDK never falls back to its bundled
  // binary. Prune all variants so the right one never sneaks in on any target.
  '@anthropic-ai/claude-agent-sdk-darwin-x64',
  '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-win32-x64',
  '@anthropic-ai/claude-agent-sdk-win32-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-x64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  // @openai/codex — main package + per-platform variants. Each platform
  // package ships a ~354 MB vendor/ (codex.exe + code-mode host) — the
  // single largest item in the bundle (v0.4.0 grew 50 MB → 135 MB). Pruned
  // entirely; the desktop bundle injects a PATH-forwarding stub under
  // node_modules/@openai/codex (see writeCodexStub) so the driver's
  // package-local resolution keeps working with the user's own install
  // (`npm i -g @openai/codex`), same contract as upstream.
  '@openai/codex',
]);

/** Dev-only packages that must never land in the production bundle. */
function isDevOnlyPackage(pkgName) {
  if (SKIP_PACKAGES.has(pkgName)) return true;
  // TypeScript type definitions are never needed at runtime.
  if (pkgName.startsWith('@types/')) return true;
  // esbuild + its per-platform binary packages are build-time only (pulled
  // in via vite/vitest/tsx dev chains).
  if (pkgName === 'esbuild' || pkgName.startsWith('@esbuild/')) return true;
  // lightningcss + its per-platform binary packages: build-time CSS minifier
  // (vite dev chain), never imported by the dsh runtime.
  if (pkgName.startsWith('lightningcss')) return true;
  // @rolldown/binding-*: Rust bundler used by vite 8 at build time only.
  if (pkgName.startsWith('@rolldown/')) return true;
  return false;
}

// Package-scoped subpath cuts — subdirectories/files inside a package that
// are never reachable at runtime. Verified against each package's
// exports/main resolution: the kept entry point is what Node resolves.
const PACKAGE_SUBPATH_SKIPS = {
  // main=./lib/index.js (CJS) — the es/ ESM build is never resolved.
  '@larksuiteoapi/node-sdk': ['es'],
  // "." resolves to dist/node/index.mjs under Node's "node" condition;
  // dist/web/ and the top-level bundles serve bundlers/browsers only.
  '@google/genai': ['dist/web', 'dist/index.cjs', 'dist/index.mjs'],
  // main=dist/index.js — browser/ is the bundler build.
  'jimp': ['browser'],
  // node-pty: only lib/ (loader) + prebuilds/ (target platform, pruned
  // below) + build/ (node-gyp fallback — node-pty ships NO linux prebuilds,
  // so Linux builds rely on the compiled build/Release/pty.node) are needed
  // at runtime; deps/, third_party/, src/, scripts/ are node-gyp sources.
  'node-pty': ['deps', 'third_party', 'src', 'scripts'],
};

// Per-package post-copy pruning. node-pty ships prebuilds for every
// platform (~60MB) but only the current target's binaries are reachable.
const PACKAGE_POST_COPY = {
  'node-pty': (pkgDir) => {
    const prebuilds = path.join(pkgDir, 'prebuilds');
    if (!fs.existsSync(prebuilds)) return;
    for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const keepPrefix = `${TARGET_OS}-${TARGET_ARCH}`;
      if (!entry.name.startsWith(keepPrefix)) {
        fs.rmSync(path.join(prebuilds, entry.name), { recursive: true, force: true });
        log(`  ✂ node-pty/prebuilds/${entry.name} (wrong platform)`);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`  ${msg}\n`);
  try {
    fs.mkdirSync(STAGING, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* log file unavailable — stdout only */
  }
}

/**
 * Check if a package is a platform-specific native binary for the WRONG platform.
 * Many packages (e.g. sharp via @img/sharp-*) ship optional dependencies for
 * every OS+arch combination. We only need the current target platform's binaries
 * — the rest are dead weight that can easily add 200+ MB to the installer.
 */
// Target platform for native binary pruning. Default: win32-x64 (desktop main
// release); CI (macOS runners, Linux) overrides via DSHD_TARGET_PLATFORM
// (e.g. darwin-arm64, darwin-x64, linux-x64).
const TARGET_PLATFORM = process.env.DSHD_TARGET_PLATFORM || 'win32-x64';
const [TARGET_OS, TARGET_ARCH] = TARGET_PLATFORM.split('-');

function isWrongPlatformBinary(pkgName) {
  // @img/sharp-* packages: keep only colour (shared) + the target platform variant
  if (pkgName.startsWith('@img/sharp-') || pkgName.startsWith('@img/sharp-libvips-')) {
    if (pkgName === '@img/colour') return false;
    const keepPrefix = `@img/sharp-${TARGET_OS}-${TARGET_ARCH}`;
    if (pkgName.startsWith(keepPrefix)) return false;
    // sharp 0.35+ loads libvips via @rpath from the separate
    // @img/sharp-libvips-<os>-<arch> package on macOS/Linux — pruning it
    // breaks dsh startup there (ERR_DLOPEN_FAILED: libvips-cpp dylib not
    // found). Windows bundles the DLLs inside @img/sharp-win32-x64, so the
    // duplicate libvips package stays pruned (keeps the installer small).
    if (TARGET_OS !== 'win32') {
      const libvipsPrefix = `@img/sharp-libvips-${TARGET_OS}-${TARGET_ARCH}`;
      if (pkgName.startsWith(libvipsPrefix)) return false;
    }
    return true;
  }

  // @node-rs/jieba-*: Chinese text segmentation with per-platform native binaries.
  // Keep only the target platform variant.
  if (pkgName.startsWith('@node-rs/jieba-')) {
    const keepPrefix = `@node-rs/jieba-${TARGET_OS}-${TARGET_ARCH}-`;
    if (!pkgName.startsWith(keepPrefix)) return true;
  }

  // @koromix/koffi-*: koffi's prebuilt native binary, one package per
  // platform. Keep only the target platform variant.
  if (pkgName.startsWith('@koromix/koffi-')) {
    const keepPrefix = `@koromix/koffi-${TARGET_OS}-${TARGET_ARCH}`;
    if (!pkgName.startsWith(keepPrefix)) return true;
  }

  // node-addon-require-builtin-<os>-<arch>[-<libc>]: per-platform native
  // binary for the custom loader. Windows/Linux add a libc suffix
  // (win32-x64-msvc, linux-x64-gnu); macOS does not (darwin-arm64 /
  // darwin-x64). Keep only the target platform variant.
  if (pkgName.startsWith('node-addon-require-builtin-')) {
    const keepBase = `node-addon-require-builtin-${TARGET_OS}-${TARGET_ARCH}`;
    if (pkgName === keepBase) return false;
    if (pkgName.startsWith(`${keepBase}-`)) return false;
    return true;
  }

  // lightningcss-*: Rust-based CSS minifier with per-platform prebuilt
  // binaries (darwin-arm64 / linux-x64-gnu / win32-x64-msvc ...).
  if (pkgName.startsWith('lightningcss-')) {
    const keepPrefix = `lightningcss-${TARGET_OS}-${TARGET_ARCH}`;
    if (!pkgName.startsWith(keepPrefix)) return true;
  }

  // @esbuild/<os>-<arch>: esbuild's per-platform binary package.
  if (pkgName.startsWith('@esbuild/')) {
    if (pkgName !== `@esbuild/${TARGET_OS}-${TARGET_ARCH}`) return true;
  }

  // @deepseek-ai/node-addon-landlock-run-<os>-<arch>: Linux-only sandbox
  // runner (optional native binary of the landlock workspace package).
  // The main package (without suffix) is the JS loader and is always kept.
  if (pkgName.startsWith('@deepseek-ai/node-addon-landlock-run-')) {
    const keepPrefix = `@deepseek-ai/node-addon-landlock-run-${TARGET_OS}-${TARGET_ARCH}`;
    if (!pkgName.startsWith(keepPrefix)) return true;
  }

  return false;
}

function shouldSkip(relativePath) {
  // Always keep .node files (native addon binaries)
  if (relativePath.endsWith('.node')) return false;
  // Normalize to forward slashes — on Windows, path.join produces backslashes
  // but our SKIP_PATTERNS use forward slashes (cross-platform compatibility).
  const normalized = relativePath.replace(/\\/g, '/');
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}

function copyDir(src, dest, basePath, visited = new Set()) {
  // Handle broken symlinks (e.g. optional platform deps not installed)
  let stat;
  try {
    stat = fs.lstatSync(src);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    try {
      const realPath = fs.realpathSync(src);
      if (fs.statSync(realPath).isDirectory()) {
        // Symlink cycle guard (defense in depth — see the node_modules skip
        // below): never recurse into a directory we already visited on this
        // copy path.
        if (visited.has(realPath)) return;
        visited.add(realPath);
        return copyDir(realPath, dest, basePath, visited);
      }
    } catch {
      // Broken symlink — skip silently
      return;
    }
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

    if (shouldSkip(relativePath)) continue;

    if (entry.name === 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink())) {
      // CRITICAL: never descend into a package's node_modules during
      // flattening. pnpm fills these with junctions/symlinks to sibling
      // packages, and in a monorepo workspace (dsh) those links point back
      // into the workspace source tree — following them copies the whole
      // repository recursively (exponential blowup that exhausted the disk
      // on the first Windows bundle run). On Windows pnpm creates these as
      // junction points, which Node reports as symlinks — so both Dirent
      // flavors must be skipped. Node.js resolves dependencies from the
      // flat staging root instead; version conflicts are re-materialized
      // by fixNestedDeps() afterwards.
      continue;
    }

    if (entry.isSymbolicLink()) {
      // Follow symlinks: copy the actual content (pnpm style)
      try {
        const realPath = fs.realpathSync(srcPath);
        const stat = fs.statSync(realPath);
        if (stat.isDirectory()) {
          copyDir(realPath, path.join(dest, entry.name), relativePath, visited);
        } else {
          fs.copyFileSync(realPath, path.join(dest, entry.name));
        }
      } catch (err) {
        // Broken symlink or permission error — skip
        log(`WARN: skipping symlink ${relativePath}: ${err.message}`);
      }
    } else if (entry.isDirectory()) {
      copyDir(srcPath, path.join(dest, entry.name), relativePath, visited);
    } else {
      fs.copyFileSync(srcPath, path.join(dest, entry.name));
    }
  }
}

/**
 * Collect all unique packages from pnpm's dependency tree.
 * Returns Map<packageName, { name, version, path, isNative }>
 */
function collectPnpmDeps(projectDir) {
  log(`Scanning pnpm dependency tree in ${projectDir}...`);

  // Note: the old trick of temporarily renaming pnpm-workspace.yaml to force
  // non-workspace `pnpm list` no longer works — pnpm v10 in non-workspace mode
  // resolves no deps at all for a pnpm-structured node_modules. Workspace-mode
  // listing is correct and also covers subdirectory members (desktop has no
  // prod deps anymore, so the root listing is what matters).
  let output;
  try {
    // depth=20 is sufficient for any realistic dependency tree.
    // depth=100 produces enormous JSON (100+ MB) that can exceed maxBuffer
    // and cause JSON.parse to fail on truncated output (pnpm v10+).
    output = execSync('pnpm list --prod --json --depth=20', {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    // pnpm list may exit non-zero but still output valid JSON
    output = err.stdout || '';
    if (!output.trim()) {
      throw new Error(`pnpm list failed: ${err.message}`);
    }
  }

  let tree;
  try {
    tree = JSON.parse(output);
  } catch {
    // pnpm sometimes outputs to stderr instead
    if (!output.trim()) {
      throw new Error('pnpm list produced no output — is pnpm install run?');
    }
    throw new Error(`Failed to parse pnpm list output: ${output.slice(0, 500)}`);
  }

  const seen = new Map(); // path -> { name, version }
  const walk = (deps) => {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      if (!info || typeof info !== 'object') continue;
      if (info.path && !seen.has(info.path)) {
        seen.set(info.path, {
          name: name,
          version: info.version || 'unknown',
        });
      }
      // Prune the subtree of dev-only packages: skipping the parent (e.g.
      // jsdom, vitest) used to leave its whole dependency chain (istanbul
      // reporters, jsdom's css parser, ...) in the flat staging because the
      // walk still collected them. Only a skipped package's direct path is
      // registered above — its dependencies are not walked.
      if (info.dependencies && !isDevOnlyPackage(name)) {
        walk(info.dependencies);
      }
    }
  };

  // tree is an array — walk each root item
  if (Array.isArray(tree)) {
    for (const item of tree) {
      // Workspace members are reported as array items, not as dependencies
      // of the root project. Some are only reachable at runtime through
      // package-name imports (e.g. @deepseek-ai/dsh-atomic-write, imported
      // by dsh-agent-presets) but absent from the walked dependency graph
      // due to pnpm list de-dup quirks — a missing one crashes dsh at boot
      // with ERR_MODULE_NOT_FOUND. Include every item with a resolvable
      // path, except the workspace root itself (its path IS the dsh
      // checkout — copying it would duplicate the whole closure).
      if (
        item.path &&
        item.name !== '@deepseek-ai/dsh-root' &&
        item.path !== projectDir &&
        !seen.has(item.path)
      ) {
        seen.set(item.path, {
          name: item.name,
          version: item.version || 'unknown',
        });
      }
      // Do NOT descend into dev-only workspace members' dependencies: the
      // umbrella/example packages above register real dependencies (e.g.
      // dsh-examples → dsh-subagent-claude-code → @anthropic-ai/claude-agent-sdk)
      // that must never reach staging, even though the items themselves are
      // skipped by copyPnpmPkg. Mirror the recursion guard used in walk().
      if (item.dependencies && !isDevOnlyPackage(item.name)) {
        walk(item.dependencies);
      }
    }
  }

  return seen;
}

/**
 * Copy a single package from its pnpm path to the staging directory.
 * If the staging already has a package with the same name, prefer the
 * newer version (or the one with native files from desktop/node_modules).
 */
function copyPnpmPkg(pkgPath, destBase, isNativeOverride = false) {
  const pkgJsonPath = path.join(pkgPath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    // Not a proper package — copy anyway as-is
    const name = path.basename(pkgPath);
    copyDir(pkgPath, path.join(destBase, name), '');
    return;
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    pkgJson = {};
  }

  const pkgName = pkgJson.name || path.basename(pkgPath);

  // Skip well-known dev-only packages
  if (isDevOnlyPackage(pkgName)) {
    log(`  SKIP ${pkgName}@${pkgJson.version || '?'} (dev-only)`);
    return;
  }

  // Skip platform-specific native binaries for the wrong platform
  if (isWrongPlatformBinary(pkgName)) {
    log(`  SKIP ${pkgName}@${pkgJson.version || '?'} (wrong-platform native binary)`);
    return;
  }

  const destPath = path.join(destBase, pkgName);

  // If staging already has this package, check versions
  const existingPkgJsonPath = path.join(destPath, 'package.json');
  if (fs.existsSync(existingPkgJsonPath) && !isNativeOverride) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingPkgJsonPath, 'utf8'));
      // Keep the newer version — but prefer the plain-semver package over a
      // same-name platform variant (npm's "<name>@<ver>-<os>-<arch>" scheme,
      // e.g. @openai/codex@0.147.0 vs @openai/codex@0.147.0-win32-x64): the
      // variant must NOT overwrite the main package, or package.json loses
      // its bin field and the driver crashes at import time.
      if (existing.version && pkgJson.version) {
        const isVariant = (v) => /-(win32|darwin|linux)-(x64|arm64|ia32|arm)(\b|-)/i.test(v);
        const existingIsVariant = isVariant(existing.version);
        const incomingIsVariant = isVariant(pkgJson.version);
        if (existingIsVariant && !incomingIsVariant) {
          /* incoming is the main package — overwrite the variant below */
        } else if (!existingIsVariant && incomingIsVariant) {
          return; // existing is the main package — skip the variant
        } else {
          const cmp = existing.version.localeCompare(pkgJson.version, undefined, { numeric: true });
          if (cmp >= 0) return; // existing is same or newer, skip
        }
      }
    } catch { /* ignore, overwrite */ }
  }

  // Copy
  copyDir(pkgPath, destPath, '');
  // Drop package-scoped unreachable subpaths (see PACKAGE_SUBPATH_SKIPS).
  const subpathSkips = PACKAGE_SUBPATH_SKIPS[pkgName];
  if (subpathSkips) {
    for (const sub of subpathSkips) {
      const victim = path.join(destPath, sub);
      if (fs.existsSync(victim)) {
        fs.rmSync(victim, { recursive: true, force: true });
        log(`  ✂ ${pkgName}/${sub} (unreachable at runtime)`);
      }
    }
  }
  const postCopy = PACKAGE_POST_COPY[pkgName];
  if (postCopy) postCopy(destPath);
  log(`  ${pkgName}@${pkgJson.version || '?'}`);
}

/**
 * Copy the compiled server dist to the staging dir, dropping dev-only
 * artifacts. ONLY *.map and *.d.ts are removed — .ts sources are KEPT
 * because the Bedrock lazy loader (bedrock-converse-stream.lazy.js) and the
 * extension loader import .ts paths at runtime; .md files (built-in skill
 * prompts) are read by the skills system.
 */
function copyPrunedServerDist(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyPrunedServerDist(s, d);
    } else if (/\.(map|d\.ts)$/.test(entry.name)) {
      continue; // dev-only artifacts
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Copy the dsh build closure into .sidecar-deps/dsh-dist for bundling,
 * dropping every node_modules subtree (the flat staging tree resolves
 * dependencies at runtime). Unlike copyDir, this keeps ALL other files
 * (docs, .ts sources, license files) — the closure is the upstream checkout
 * as-is, and dsh's lazy loaders read .ts/.md paths at runtime.
 */
function copyRuntimeDist(src, dest, visited = new Set()) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink())) {
      continue;
    }
    // Upstream dev/docs material — never read by the running dsh CLI:
    // .agents/notes (dev journal), CI configs, docs, examples, build
    // scripts, the website workspace, cordis vendor copy (resolved as a
    // package from the flat node_modules) and native C/C++ sources.
    if (
      entry.isDirectory() &&
      RUNTIME_DIST_SKIP_DIRS.has(entry.name)
    ) {
      continue;
    }
    // Dev-only artifacts: TypeScript incremental build info + source maps.
    if (!entry.isDirectory() && /\.(tsbuildinfo|map)$/.test(entry.name)) {
      continue;
    }
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(s);
        const st = fs.statSync(real);
        if (st.isDirectory()) {
          if (visited.has(real)) continue;
          visited.add(real);
          copyRuntimeDist(real, d, visited);
        } else {
          fs.copyFileSync(real, d);
        }
      } catch {
        // Broken symlink (optional platform dep) — skip
      }
    } else if (entry.isDirectory()) {
      copyRuntimeDist(s, d, visited);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

const RUNTIME_DIST_SKIP_DIRS = new Set([
  '.agents',
  '.claude',
  // Git metadata is never read by the running dsh CLI — and the upstream
  // checkout can carry git temp files (objects/pack/tmp_pack_*) that the
  // tauri-build resource walker trips over with os error 5 (access denied).
  '.git',
  '.github',
  'docs',
  'examples',
  'native',
  'patches',
  'scripts',
  'vendor',
  'website',
  // Pure dev/test artifacts inside the upstream checkout — never read by the
  // running CLI (its lazy loaders DO read .ts/.md, so src/ and the markdown
  // stays). Raw savings ~20MB, a few MB after NSIS compression.
  'tests',
  '__tests__',
  'benchmarks',
]);

function buildRuntimeDist() {
  log('');
  log('Building pruned dsh runtime closure (dsh-dist, no node_modules)...');
  fs.rmSync(DSH_RUNTIME_DIST, { recursive: true, force: true });
  if (!fs.existsSync(DSH_DIST_SRC)) {
    throw new Error(`dsh build closure not found at ${DSH_DIST_SRC} — run fetch:dsh first`);
  }
  copyRuntimeDist(DSH_DIST_SRC, DSH_RUNTIME_DIST);
  // Top-level test snapshots (upstream checkout fixture data) — skipped here
  // rather than in the skip-set so a runtime package owning its own
  // snapshots/ subtree is unaffected.
  const topSnapshots = path.join(DSH_RUNTIME_DIST, 'snapshots');
  if (fs.existsSync(topSnapshots)) {
    fs.rmSync(topSnapshots, { recursive: true, force: true });
    log('  dropped top-level snapshots/ (test fixtures)');
  }
  log(`✅ Runtime closure ready: ${DSH_RUNTIME_DIST}`);
}

/**
 * Inject the codex PATH-forwarding stub under node_modules/@openai/codex.
 * The bundle prunes @openai/codex (per-platform vendor binaries, ~354 MB);
 * the dsh-subagent-codex driver resolves '@openai/codex/package.json' at
 * module top level and spawns `node <bin.codex> app-server --stdio` — this
 * stub satisfies that resolution and forwards argv to the user's own `codex`
 * on PATH (`npm i -g @openai/codex`), the same contract upstream expects.
 * Version 0.0.0 keeps fixNestedDeps' major-version check from trying to nest
 * a real codex package under dependents.
 */
function writeCodexStub() {
  const dir = path.join(STAGING_NM, '@openai', 'codex');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@openai/codex',
        version: '0.0.0-desktop-stub',
        description:
          'Desktop stub: forwards to codex on PATH (platform binaries pruned from the bundle)',
        private: true,
        bin: { codex: 'bin/codex.js' },
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'bin', 'codex.js'),
    `#!/usr/bin/env node
// Desktop codex stub — forwards argv to the user-installed \`codex\` on PATH.
// @openai/codex (per-platform vendor binaries, ~354 MB) is pruned from the
// bundle; the dsh-subagent-codex driver resolves this package and spawns
// \`node bin/codex.js app-server --stdio\` — this shim hands the call to the
// host's codex instead (install with: npm install -g @openai/codex).
'use strict';
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
const isWin = process.platform === 'win32';
const child = spawn(isWin ? 'codex.cmd' : 'codex', argv, {
  stdio: 'inherit',
  shell: isWin, // codex.cmd must run under cmd.exe on Windows
});
child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(
      '[dsh-desktop] codex not found on PATH — install it with: npm install -g @openai/codex',
    );
    process.exit(127);
  }
  console.error('[dsh-desktop] codex launch failed:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
  );
  log(`  ✚ @openai/codex stub (PATH-forwarding — codex binaries pruned)`);
}

/**
 * For packages whose dependencies require a different major version than what
 * ended up in the flat node_modules, copy the correct version into a nested
 * node_modules directory under that package.
 *
 * Example: lazystream depends on readable-stream@^2 but the flat directory
 * has readable-stream@4. We create lazystream/node_modules/readable-stream/
 * with the v2 content so Node.js resolves it correctly.
 */
function fixNestedDeps(allDeps) {
  // Index: packageName → [{version, pkgPath}]
  const byName = new Map();
  for (const [pkgPath, info] of allDeps) {
    const list = byName.get(info.name) || [];
    list.push({ version: info.version, pkgPath, name: info.name });
    byName.set(info.name, list);
  }

  // Sort each list by version descending
  for (const list of byName.values()) {
    list.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true })
    );
  }

  // Iterate over packages in the staging directory
  const entries = fs.readdirSync(STAGING_NM, { withFileTypes: true });
  let fixedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(STAGING_NM, entry.name);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }

    const deps = { ...pkgJson.dependencies, ...pkgJson.peerDependencies };
    if (!deps || Object.keys(deps).length === 0) continue;

    for (const [depName, depRange] of Object.entries(deps)) {
      // Skip optional/peer deps that start with @types
      if (depName.startsWith('@types/')) continue;

      const flatDepDir = path.join(STAGING_NM, depName);
      const flatPkgJsonPath = path.join(flatDepDir, 'package.json');
      if (!fs.existsSync(flatPkgJsonPath)) continue;

      let flatVersion;
      try {
        flatVersion = JSON.parse(fs.readFileSync(flatPkgJsonPath, 'utf8')).version;
      } catch {
        continue;
      }

      // Simple semver check: if major versions differ, the dep needs its own copy
      if (!needsNestedDep(flatVersion, depRange)) continue;

      // Find the correct version from the pnpm tree
      const candidates = byName.get(depName) || [];
      const match = candidates.find((c) => satisfiesMajor(c.version, depRange));
      if (!match) continue;

      // Skip if already has nested node_modules with this dep
      const nestedDir = path.join(pkgDir, 'node_modules', depName);
      if (fs.existsSync(nestedDir)) continue;

      // Copy the correct version
      fs.mkdirSync(path.dirname(nestedDir), { recursive: true });
      copyDir(match.pkgPath, nestedDir, '');
      fixedCount++;
      log(`  ${entry.name} → ${depName}@${match.version} (flat has ${flatVersion}, needs ${depRange})`);
    }
  }

  if (fixedCount > 0) {
    log(`Fixed ${fixedCount} version conflict(s) with nested node_modules`);
  }
}

/**
 * Check if a version satisfies a semver range (simplified: only checks major version).
 */
function needsNestedDep(version, range) {
  const verMajor = parseInt(version.split('.')[0], 10);
  const clean = range.replace(/^[~^>=<]+/, '');
  const rangeMajor = parseInt(clean.split('.')[0], 10);
  return verMajor !== rangeMajor;
}

/**
 * Check if a version's major matches the range's major.
 */
function satisfiesMajor(version, range) {
  const verMajor = parseInt(version.split('.')[0], 10);
  const clean = range.replace(/^[~^>=<]+/, '');
  const rangeMajor = parseInt(clean.split('.')[0], 10);
  return verMajor === rangeMajor;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** sha256 of pnpm-lock.yaml — the set of flattened packages must follow the
 * lockfile, not just the dsh ref: adding a prod dependency with the staging
 * cached used to ship a bundle that crashed at import time. */
function lockfileHash() {
  try {
    const raw = fs.readFileSync(path.join(DESKTOP, 'pnpm-lock.yaml'), 'utf8');
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function main() {
  log('');
  log('📦 Preparing flat node_modules for the Tauri sidecar...');
  log('');

  // Fast path: staging already flattened for this exact target + dsh ref.
  // tauri build's beforeBuildCommand re-runs bundle-deps after build.ps1 /
  // CI already flattened — without this every build re-copies ~900 packages
  // twice (disk/CPU churn, minutes on Windows). Mirror of fetch-dsh.cjs.
  let pinnedRef = '';
  try {
    pinnedRef = JSON.parse(fs.readFileSync(DSH_REF_FILE, 'utf8')).ref || '';
  } catch {
    /* no dsh-ref.json — full flatten below */
  }
  const lockHash = lockfileHash();
  try {
    const manifest = JSON.parse(fs.readFileSync(BUNDLE_MANIFEST_FILE, 'utf8'));
    const count = fs.existsSync(STAGING_NM)
      ? fs.readdirSync(STAGING_NM).length
      : 0;
    if (
      manifest.bundleDepsVersion === BUNDLE_DEPS_VERSION &&
      manifest.ref === pinnedRef &&
      manifest.targetPlatform === TARGET_PLATFORM &&
      manifest.lockHash === lockHash &&
      count > 100 &&
      fs.existsSync(DSH_RUNTIME_DIST)
    ) {
      log(
        `Staging already complete for ${TARGET_PLATFORM} @ ${pinnedRef.slice(0, 12)} ` +
          `(${count} packages) — skipping flatten (delete .sidecar-deps to force)`,
      );
      log('');
      return;
    }
  } catch {
    /* no manifest — full flatten below */
  }

  // 1. Clean and recreate staging
  // Clear staging subdirs but keep `.sidecar-deps/runtime` (bundled Node
  // runtime, fetched separately — wiping it would force a re-download) and
  // `.sidecar-deps/pnpm` (bundled pnpm, fetched by fetch-pnpm.cjs).
  fs.rmSync(path.join(STAGING, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(STAGING, 'root'), { recursive: true, force: true });
  fs.mkdirSync(STAGING_NM, { recursive: true });

  // 2. Collect pnpm dependencies from root project
  const rootDeps = collectPnpmDeps(ROOT);
  log(`Found ${rootDeps.size} unique packages in root dependency tree`);
  log('');

  // 3. Collect pnpm dependencies from desktop project (electron-store, electron-updater, etc.)
  const desktopDeps = collectPnpmDeps(DESKTOP);
  log(`Found ${desktopDeps.size} unique packages in desktop dependency tree`);
  log('');

  // 3b. Backfill desktop deps that were hoisted to root node_modules by workspace.
  // When workspace mode is disabled during pnpm list, packages that pnpm hoisted
  // to the root (e.g. ws) are invisible to the desktop collectPnpmDeps call.
  // Walk desktop's package.json dependencies and check root node_modules for any
  // that are missing from the collected set.
  log('Backfilling workspace-hoisted desktop deps from root node_modules...');
  const rootNm = path.join(ROOT, 'node_modules');
  const desktopPkgJsonPath = path.join(DESKTOP, 'package.json');
  if (fs.existsSync(desktopPkgJsonPath) && fs.existsSync(rootNm)) {
    let desktopPkg;
    try { desktopPkg = JSON.parse(fs.readFileSync(desktopPkgJsonPath, 'utf8')); } catch { desktopPkg = {}; }
    const desktopProdDeps = { ...desktopPkg.dependencies };
    let backfilled = 0;
    for (const depName of Object.keys(desktopProdDeps)) {
      // Check if already collected
      const alreadyCollected = [...desktopDeps.values()].some(d => d.name === depName)
        || [...rootDeps.values()].some(d => d.name === depName);
      if (alreadyCollected) continue;
      // Look in root node_modules (workspace-hoisted location)
      const rootDepPath = path.join(rootNm, depName);
      if (fs.existsSync(path.join(rootDepPath, 'package.json'))) {
        desktopDeps.set(rootDepPath, { name: depName, version: desktopProdDeps[depName] });
        backfilled++;
        log(`  ✓ ${depName} (from root node_modules)`);
      }
    }
    if (backfilled > 0) log(`Backfilled ${backfilled} hoisted desktop dep(s)`);
  }

  // Merge both (desktop wins on conflict)
  const allDeps = new Map(rootDeps);
  for (const [pkgPath, info] of desktopDeps) {
    allDeps.set(pkgPath, info);
  }
  log(`Total unique packages (merged): ${allDeps.size}`);
  log('');

  // 4. Copy all packages to staging
  log('Copying packages from pnpm node_modules...');
  for (const [pkgPath, { name }] of allDeps) {
    copyPnpmPkg(pkgPath, STAGING_NM);
  }

  // 4b. Inject the codex PATH-forwarding stub (codex itself was pruned in
  // step 4). Written before fixNestedDeps so its version comparison sees the
  // stub and never tries to nest a real codex package.
  writeCodexStub();

  // 5. Verify native addons are present (Node ABI — pnpm prebuilds on the
  // build machine, matching the bundled Node runtime major version).
  // Note: sharp ships .node in @img/sharp-<os>-<arch>; node-pty / koffi /
  // node-addon-require-builtin keep .node in their main package.
  log('');
  log('Verifying native addons (Node ABI)...');
  for (const addonName of NATIVE_ADDONS) {
    let searchDirs;
    if (addonName === 'sharp') {
      searchDirs = [path.join(STAGING_NM, '@img', `sharp-${TARGET_OS}-${TARGET_ARCH}`)];
    } else if (addonName === 'koffi') {
      // Prebuilt lives in the platform package (@koromix/koffi-<os>-<arch>);
      // the koffi main package only carries C++ sources + the loader.
      searchDirs = [
        path.join(STAGING_NM, '@koromix', `koffi-${TARGET_OS}-${TARGET_ARCH}`),
        path.join(STAGING_NM, addonName),
      ];
    } else if (addonName === 'node-addon-require-builtin') {
      // Prebuilt lives in node-addon-require-builtin-<os>-<arch>[-<libc>]
      // (win32-x64-msvc / linux-x64-gnu / darwin-arm64 ...).
      const keepBase = `node-addon-require-builtin-${TARGET_OS}-${TARGET_ARCH}`;
      const variantDirs = fs
        .readdirSync(STAGING_NM, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            (e.name === keepBase || e.name.startsWith(`${keepBase}-`)),
        )
        .map((e) => path.join(STAGING_NM, e.name));
      searchDirs = [...variantDirs, path.join(STAGING_NM, addonName)];
    } else {
      searchDirs = [path.join(STAGING_NM, addonName)];
    }
    const nativeFiles = searchDirs.flatMap(findNativeFiles);
    if (nativeFiles.length === 0) {
      log(`  ✗ ${addonName}: no native files found in staging!`);
      log('    (build machine Node major must match the bundled node runtime — see .node-version)');
      process.exit(1);
    }
    log(`  ✓ ${addonName} (${nativeFiles.length} native file(s))`);
  }

  // 6. Fix nested dependencies for version conflicts
  // When pkg A depends on dep@^1 but flat node_modules has dep@2, Node.js
  // resolution fails. Copy the correct version into A/node_modules/dep/.
  log('');
  log('Fixing nested dependencies for version conflicts...');
  fixNestedDeps(allDeps);

  // 7. Report stats
  const count = fs.readdirSync(STAGING_NM).length;
  buildRuntimeDist();
  fs.writeFileSync(
    BUNDLE_MANIFEST_FILE,
    JSON.stringify(
      {
        bundleDepsVersion: BUNDLE_DEPS_VERSION,
        ref: pinnedRef,
        targetPlatform: TARGET_PLATFORM,
        lockHash,
        packageCount: count,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  log('');
  log(`✅ Staging complete: ${count} packages in ${STAGING_NM}`);
  log('');
}

main();
