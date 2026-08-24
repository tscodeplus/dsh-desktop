#!/usr/bin/env node
/**
 * fetch-dsh.cjs — single-mode dependency entry for the desktop shell.
 *
 * Builds dsh (DeepSeek Harness) from the upstream git repo at the exact ref
 * recorded in dsh-ref.json (or overridden with --ref). There is no npm
 * dependency path: every build is traceable to a commit.
 *
 *   · clone/fetch the upstream repo into .dsh-build/dist (checked out, built
 *     in place — this directory IS the dsh closure that bundle-deps and the
 *     Tauri resources consume). The .git metadata is removed after a
 *     successful build: tauri-build walks the resources tree at compile time
 *     and chokes on git's read-only pack files (EACCES on rebuild), and
 *     bundling .git would bloat the installer. The next fetch re-inits and
 *     shallow-fetches the pinned ref (a few MB for a tag/tip).
 *   · `pnpm install --frozen-lockfile` + `pnpm run build` (upstream lockfile
 *     makes the dependency closure reproducible)
 *   · verify the CLI entry the sidecar will spawn; write a provenance manifest
 *   · LAN/Tailscale remote-access patches (crypto shim, privileged-trust
 *     fence, client host-mode, plugin fences) are applied when
 *     DSHD_ENABLE_REMOTE_ACCESS is exactly 'on' — dsh-desktop release CI
 *     (desktop-release / engine-build) and the local build scripts
 *     (build.ps1, pnpm tauri:build*) set it, so released installers carry the
 *     patches. Any other value (incl. unset) yields an UPSTREAM-PURE closure
 *     for dev/debug — never ship those. The patches deliberately alter
 *     upstream security boundaries (declared trustedHosts admit the config
 *     plane; no auth), so expose only to trusted devices. The manifest
 *     records the state so the fast path never reuses a closure built with
 *     the opposite state (it rebuilds instead).
 *
 * Discipline (see docs/IMPLEMENTATION_PLAN.md §5):
 *   · default to release (tag) refs once upstream starts tagging
 *   · a non-release commit needs mode:"commit" + a note explaining why
 *   · keep last-known-good: on failure, revert dsh-ref.json to the previous ref
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { patchWebUiIndex } = require('./patch-webui-index.cjs');
const { patchConnectionPrivileges } = require('./patch-connection-privileges.cjs');
const { patchSettingsOrigin } = require('./patch-settings-origin.cjs');
const { patchPluginFences } = require('./patch-plugin-fences.cjs');

/**
 * Remote-access patches for the shipped desktop: release CI (both workflows)
 * and the local build scripts set DSHD_ENABLE_REMOTE_ACCESS=on, so released
 * closures carry them. Unset or any other value = upstream-pure closure
 * (dev/debug only). Always re-applying each patch is idempotent.
 */
const REMOTE_ACCESS = (process.env.DSHD_ENABLE_REMOTE_ACCESS ?? 'off') === 'on';

/**
 * Apply the dsh-desktop remote-access patch passes (see the patch-* modules)
 * when enabled; log the state either way. Idempotent on already-patched
 * closures.
 * @param {string} dshDir - dsh root the patches target.
 * @returns {void}
 */
function applyRemoteAccessPatches(dshDir) {
  if (!REMOTE_ACCESS) {
    console.log(
      '[fetch-dsh] remote-access patches OFF — upstream-pure closure (DSHD_ENABLE_REMOTE_ACCESS=on'
      + ' opts in; release CI and local build scripts set it; dev-only)',
    );
    return;
  }
  patchWebUiIndex(dshDir);
  patchConnectionPrivileges(dshDir);
  patchSettingsOrigin(dshDir);
  patchPluginFences(dshDir);
}

const DESKTOP = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(DESKTOP, '.dsh-build');
const DSH_DIR = path.join(BUILD_DIR, 'dist');
const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness.git';
const REF_FILE = path.join(DESKTOP, 'dsh-ref.json');
const MANIFEST_FILE = path.join(BUILD_DIR, 'dsh.manifest.json');
// The entry the sidecar spawns in prod (sidecar/src/index.ts).
const CLI_ENTRY = path.join(DSH_DIR, 'apps', 'cli', 'lib', 'bin.js');

// Target platform for the build closure's native modules. CI overrides via
// DSHD_TARGET_PLATFORM (e.g. darwin-x64); default win32-x64 (desktop main
// release). Must stay in sync with bundle-deps.cjs — the closure is NOT
// portable across platforms (koffi/@koromix ships one platform package per
// arch), so the fast path below also verifies the platform.
const TARGET_PLATFORM = process.env.DSHD_TARGET_PLATFORM || 'win32-x64';

function sh(cmd, cwd, env) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: env ?? process.env });
}

/**
 * dsh's lockfile is pnpm 11 (packageManager: pnpm@11.7.0). Prefer pnpm 11 on
 * PATH; fall back to corepack (reads the packageManager field and provisions
 * the right version); fail with a clear hint otherwise.
 */
function pnpmCmd() {
  try {
    const v = execSync('pnpm --version', { encoding: 'utf8' }).trim();
    const major = Number(v.split('.')[0]);
    if (major === 11) {
      console.log(`[fetch-dsh] pnpm ${v}`);
      return 'pnpm';
    }
    console.log(`[fetch-dsh] pnpm ${v} (major != 11) — falling back to corepack pnpm`);
  } catch {
    console.log('[fetch-dsh] pnpm not found — falling back to corepack pnpm');
  }
  try {
    const v = execSync('corepack pnpm --version', { encoding: 'utf8' }).trim();
    console.log(`[fetch-dsh] corepack pnpm ${v}`);
    return 'corepack pnpm';
  } catch {
    console.error('[fetch-dsh] no pnpm 11 found — install with `npm install -g pnpm@11` or enable corepack');
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const refIdx = argv.indexOf('--ref');
  const overrideRef = refIdx >= 0 ? argv[refIdx + 1] : undefined;
  const force = argv.includes('--force');
  // Source-only fetch: checkout the pinned ref but skip pnpm install + build.
  // Used on dev machines (e.g. WSL) that only need the closure source — the
  // platform-specific build happens on the packaging host (Windows/macOS).
  const skipBuild = argv.includes('--no-build');

  const refDoc = JSON.parse(fs.readFileSync(REF_FILE, 'utf8'));
  const ref = overrideRef || refDoc.ref;
  if (!ref) {
    console.error('[fetch-dsh] dsh-ref.json is missing "ref"');
    process.exit(1);
  }

  // Fast path: the closure for this exact ref already exists (built by an
  // earlier fetch). tauri build's beforeBuildCommand calls fetch:dsh too, so
  // without this every build would re-clone + re-install + re-build.
  if (!force) {
    try {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
      if (
        manifest.ref === ref &&
        manifest.platform === TARGET_PLATFORM &&
        manifest.remoteAccess === REMOTE_ACCESS &&
        fs.existsSync(CLI_ENTRY)
      ) {
        console.log(
          `[fetch-dsh] closure already built for ${TARGET_PLATFORM} @ ${ref.slice(0, 12)} — skipping ` +
            '(use --force to rebuild, or delete .dsh-build)',
        );
        // Matched closures also carry the patch state they were built with
        // (manifest.remoteAccess); re-apply only idempotently when enabled.
        applyRemoteAccessPatches(DSH_DIR);
        return;
      }
    } catch {
      /* no manifest yet — full build below */
    }
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  // Wipe the previous closure and re-init. After a successful build the .git
  // dir is removed (see header comment), so a fresh git init would see the old
  // closure's files as untracked and `git checkout` would refuse to overwrite
  // same-named ones. Wiping also absorbs interrupted runs. On Windows, plain
  // rm / MSYS `git clean -fdx` both choke on NTFS long paths inside
  // node_modules/.pnpm (> MAX_PATH) — robocopy /MIR from an empty dir handles
  // them natively.
  if (process.platform === 'win32') {
    const empty = path.join(BUILD_DIR, '.empty');
    fs.mkdirSync(empty, { recursive: true });
    const robocopy = `robocopy "${empty}" "${DSH_DIR}" /MIR /NFL /NDL /NJH /NJS /R:1 /W:1`;
    try {
      execSync(robocopy, { stdio: 'inherit' });
    } catch (e) {
      // robocopy exit codes 0-7 are success (1 = files removed/copied);
      // execSync throws on any non-zero, so only >=8 is a real failure.
      if ((e.status ?? 8) >= 8) throw e;
    }
    fs.rmSync(empty, { recursive: true, force: true });
  } else {
    fs.rmSync(DSH_DIR, { recursive: true, force: true });
  }
  console.log(`[fetch-dsh] initializing clone at ${DSH_DIR} ...`);
  fs.mkdirSync(DSH_DIR, { recursive: true });
  sh('git init', DSH_DIR);
  sh(`git remote add origin ${UPSTREAM}`, DSH_DIR);

  console.log(`[fetch-dsh] fetching ref ${ref} ...`);
  // Larger POST buffer + HTTP/1.1 reduce early-EOF disconnects on big
  // fetches (Windows git's schannel backend drops HTTP/2 connections).
  sh('git config http.postBuffer 524288000', DSH_DIR);
  sh('git config http.version HTTP/1.1', DSH_DIR);
  const fetchRef = (shallow) => {
    // A failed shallow fetch may be a deep commit OR a flaky network; the
    // repo may carry no shallow state at all, in which case `--unshallow`
    // errors with "does not make sense". Probe first, then plain full fetch.
    if (!shallow) {
      try {
        const isShallow = execSync('git rev-parse --is-shallow-repository', {
          cwd: DSH_DIR,
          encoding: 'utf8',
        }).trim();
        if (isShallow === 'true') sh('git fetch --unshallow origin', DSH_DIR);
      } catch {
        /* not shallow — plain fetch below */
      }
    }
    // Flaky networks drop mid-fetch; retry a few times before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        sh(
          shallow
            ? `git fetch --depth 1 origin ${ref}`
            : `git fetch origin ${ref}`,
          DSH_DIR,
        );
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
        console.log(`[fetch-dsh] fetch attempt ${attempt} failed — retrying`);
      }
    }
  };
  try {
    // Shallow fetch of the exact ref (works for tags and for commits reachable
    // from the default branch).
    fetchRef(true);
  } catch {
    console.log('[fetch-dsh] shallow fetch failed — falling back to full fetch');
    fetchRef(false);
  }
  sh(`git checkout --detach --force ${ref}`, DSH_DIR);

  // Toolchain: dsh requires Node ^22.19 || >=24 and pnpm 11 (see packageManager).
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    console.error(`[fetch-dsh] Node ${process.versions.node} too old — dsh needs ^22.19 || >=24`);
    process.exit(1);
  }
  if (!skipBuild) {
    const pnpm = pnpmCmd();
    console.log('[fetch-dsh] installing dependencies (upstream lockfile) ...');
    sh(`${pnpm} install --frozen-lockfile`, DSH_DIR);
    console.log('[fetch-dsh] building dsh (lib + web frontend) ...');
    // Official client profile: without it the web UI falls back to the
    // upstream "DSH Local Build" brand (the sidebar brand plugin
    // ui-brand-official gates on DSH_CLIENT_BUILD_PROFILE=official). The
    // commit hash is the closure's checkout HEAD — the pinned ref itself.
    const buildEnv = {
      ...process.env,
      DSH_BUILD_CLIENT_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: execSync('git rev-parse HEAD', {
        cwd: DSH_DIR,
        encoding: 'utf8',
      }).trim(),
    };
    sh(`${pnpm} run build`, DSH_DIR, buildEnv);
    // The build above regenerates every patched artifact (web dist, built
    // host/client libs), so the LAN patches are (re)applied after each build
    // when opted in — see applyRemoteAccessPatches().
    applyRemoteAccessPatches(DSH_DIR);
  } else {
    console.log('[fetch-dsh] --no-build: skipping pnpm install + build (source-only closure)');
  }

  if (fs.existsSync(CLI_ENTRY)) {
    console.log(`[fetch-dsh] OK: CLI entry ${CLI_ENTRY}`);
  } else {
    console.warn(`[fetch-dsh] WARN: expected CLI entry not found: ${CLI_ENTRY}`);
    console.warn('         The sidecar spawn path may need updating (desktop/sidecar/src/index.ts).');
  }

  const manifest = {
    ref,
    platform: TARGET_PLATFORM,
    tag: refDoc.tag ?? null,
    mode: refDoc.mode ?? 'commit',
    note: refDoc.note ?? '',
    fetchedAt: new Date().toISOString(),
    cliEntry: fs.existsSync(CLI_ENTRY) ? CLI_ENTRY : null,
    // Patched state this closure was built with; the fast path refuses to
    // reuse a closure whose state differs from the current opt-in.
    remoteAccess: REMOTE_ACCESS,
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[fetch-dsh] done — provenance manifest at ${MANIFEST_FILE}`);

  // Runtime engine provenance — travels inside the built closure itself so
  // the sidecar (engine-updater.ts readEngineRef) and package-engine.cjs can
  // read the current engine version at runtime without touching dsh-ref.json
  // (which is not packaged). bundle-deps copyRuntimeDist carries it through
  // untouched (not in RUNTIME_DIST_SKIP_DIRS).
  const engineRefFile = path.join(DSH_DIR, '.engine-ref.json');
  const engineRef = {
    ref,
    tag: refDoc.tag ?? null,
    upstreamVersion:
      refDoc.upstreamVersion ?? (refDoc.tag ? refDoc.tag.replace(/^dsh-v/i, '') : null),
    platform: TARGET_PLATFORM,
    mode: refDoc.mode ?? 'commit',
    note: refDoc.note ?? '',
    builtAt: new Date().toISOString(),
    cliEntry: fs.existsSync(CLI_ENTRY) ? CLI_ENTRY : null,
    remoteAccess: REMOTE_ACCESS,
  };
  fs.writeFileSync(engineRefFile, JSON.stringify(engineRef, null, 2) + '\n');
  console.log(`[fetch-dsh] engine provenance at ${engineRefFile}`);

  // Keep the closure free of git metadata (see header comment).
  const gitDir = path.join(DSH_DIR, '.git');
  if (fs.existsSync(gitDir)) {
    fs.rmSync(gitDir, { recursive: true, force: true });
    console.log('[fetch-dsh] removed .git from build closure');
  }
}

main();
