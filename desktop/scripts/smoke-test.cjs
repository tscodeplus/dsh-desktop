#!/usr/bin/env node
/**
 * smoke-test.cjs — regression gate for the dsh build closure and the
 * sidecar's spawn contract (IMPLEMENTATION_PLAN.md §12.3).
 *
 * Verifies, against the locally built closure (desktop/.dsh-build/dist):
 *   1. provenance manifest + CLI entry exist
 *   2. the built CLI answers `--version`
 *   3. the profile-patch migration reconciles a stale user-layer
 *      `plugin-manager` disable (upstream 0.2.x presets depend on the service)
 *   4. `dsh web` starts on 127.0.0.1:3080 and serves the WebUI
 *   5. every agent preset in the roster composes clean (no `broken` "waiting for")
 *   6. SIGTERM reaps the process tree (no orphaned dsh / node left)
 *
 * The sidecar spawns the exact same command (prod path:
 * `<bundled-node> apps/cli/lib/bin.js web`, cwd = closure root), so this
 * doubles as a contract test for sidecar/src/index.ts.
 *
 * Usage: node scripts/smoke-test.cjs   (from desktop/, after pnpm fetch:dsh)
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const DESKTOP = path.resolve(__dirname, '..');
const DSH_DIR = path.join(DESKTOP, '.dsh-build', 'dist');
const MANIFEST_FILE = path.join(DESKTOP, '.dsh-build', 'dsh.manifest.json');
const CLI_ENTRY = path.join(DSH_DIR, 'apps', 'cli', 'lib', 'bin.js');
const PORT = Number(process.env.DSHD_PORT || 3080);
const READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1000;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function httpReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      // Any HTTP response means the server is up and listening. Since
      // 0.1.2-alpha.1 the BrowserAuth token gate answers 401/303 on the
      // index for unauthenticated probes — a `res.ok`-only check timed out
      // against healthy servers (the sidecar's own ready probe is
      // token-free /_desktop/ready on its control port).
      if (res.status >= 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

function portInUse() {
  try {
    const net = require('net');
    const srv = net.createServer();
    return new Promise((resolve) => {
      srv.once('error', () => resolve(true));
      srv.once('listening', () => srv.close(() => resolve(false)));
      srv.listen(PORT, '127.0.0.1');
    });
  } catch {
    return Promise.resolve(false);
  }
}

async function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function main() {
  console.log('[smoke-test] dsh build closure regression check');
  console.log(`  closure: ${DSH_DIR}`);

  // 1. Provenance + entry.
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    // fall through to the explicit FAIL below
  }
  check(
    'provenance manifest exists',
    !!manifest && typeof manifest.ref === 'string',
    manifest ? `ref ${manifest.ref.slice(0, 12)}` : 'missing — run `pnpm fetch:dsh` first',
  );
  check('CLI entry exists', fs.existsSync(CLI_ENTRY), CLI_ENTRY);
  // Runtime engine provenance — the sidecar's engine-updater reads this from
  // the closure; package-engine.cjs refuses to pack without it.
  const engineRefFile = path.join(DSH_DIR, '.engine-ref.json');
  let engineRef = null;
  try {
    engineRef = JSON.parse(fs.readFileSync(engineRefFile, 'utf8'));
  } catch {
    // fall through to the explicit FAIL below
  }
  check(
    'engine provenance (.engine-ref.json)',
    !!engineRef && typeof engineRef.ref === 'string' && /^[0-9a-f]{40}$/.test(engineRef.ref),
    engineRef ? `ref ${engineRef.ref.slice(0, 12)}` : 'missing — run `pnpm fetch:dsh` first',
  );
  if (!manifest || !fs.existsSync(CLI_ENTRY)) {
    console.error('[smoke-test] aborting: closure not built (run `pnpm fetch:dsh`)');
    process.exit(1);
  }

  // 2. CLI --version.
  try {
    const out = execFileSync(process.execPath, [CLI_ENTRY, '--version'], {
      cwd: DSH_DIR,
      encoding: 'utf8',
      timeout: 30_000,
    });
    check('CLI --version', /^\d+\.\d+\.\d+/.test(out.trim()), out.trim());
  } catch (e) {
    check('CLI --version', false, String(e.message || e));
  }

  // 3. Bundled pnpm (plugin management runs `dsh plugin` which spawns pnpm).
  const pnpmEntry = path.join(DESKTOP, '.sidecar-deps', 'pnpm', 'bin', 'pnpm.cjs');
  check(
    'bundled pnpm entry exists',
    fs.existsSync(pnpmEntry),
    pnpmEntry.replace(DESKTOP + path.sep, ''),
  );
  if (fs.existsSync(pnpmEntry)) {
    try {
      const out = execFileSync(process.execPath, [pnpmEntry, '--version'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      check('bundled pnpm runs', /^\d+\.\d+\.\d+/.test(out.trim()), `pnpm ${out.trim()}`);
    } catch (e) {
      check('bundled pnpm runs', false, String(e.message || e));
    }
  }

  // 3b. Profile patch migration — upstream 0.2.x agent presets mount
  // tool-plugin-manager, which waits forever on the host pluginManager
  // service when a stale user-layer disable of that row survives. The
  // migration must reconcile it (pure-core behavior is unit-tested; here we
  // exercise the file wrapper). The version gate reads .engine-ref.json off
  // the closure root, so point it at a fake 0.2.x closure — the gate must
  // also hold for the real bundled closure (own 0.1.2 seed → no-op).
  const migrationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-patch-'));
  let migrationModule = null;
  let migrationLoadError = null;
  try {
    migrationModule = await import(
      pathToFileURL(path.join(DESKTOP, '.sidecar-deps', 'root', 'patch-migration.js')).href
    );
  } catch (e) {
    migrationLoadError = e;
  }
  check(
    'migration module loads from the built sidecar dist',
    !!migrationModule && typeof migrationModule.migrateStalePluginManagerDisable === 'function',
    migrationLoadError
      ? `run pnpm build:sidecar (${migrationLoadError.message || migrationLoadError})`
      : path.join('.sidecar-deps', 'root', 'patch-migration.js'));
  if (migrationModule) {
    const fakeClosure = path.join(migrationHome, 'fake-closure-0.2.x');
    fs.mkdirSync(fakeClosure, { recursive: true });
    fs.writeFileSync(
      path.join(fakeClosure, '.engine-ref.json'),
      JSON.stringify({ ref: 'f'.repeat(40), upstreamVersion: migrationModule.MIN_MIGRATE_VERSION }),
      'utf8',
    );
    const patchDir = path.join(migrationHome, 'profiles', 'web');
    fs.mkdirSync(patchDir, { recursive: true });
    const patchFile = path.join(patchDir, 'cordis.patch.yml');
    fs.writeFileSync(
      patchFile,
      [
        '- id: webserver',
        '  config:',
        "    host: '0.0.0.0'",
        '# dsh-plugin-manager:managed:start',
        '- id: plugin-manager',
        '  disabled: true',
        '- id: agent-default-model',
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        '  config:',
        '    provider: deepseek-official',
        '# dsh-plugin-manager:managed:end',
        '',
      ].join('\n'),
      'utf8',
    );
    let outcome = null;
    let migrationRunError = null;
    try {
      outcome = migrationModule.migrateStalePluginManagerDisable(migrationHome, fakeClosure);
      // The gate must refuse to touch user data for pre-0.2.x closures.
      const gated = migrationModule.migrateStalePluginManagerDisable(migrationHome, DSH_DIR);
      if (gated !== null) {
        outcome = null;
        migrationRunError = new Error('version gate failed: migrated a pre-0.2.x closure');
      }
    } catch (e) {
      migrationRunError = e;
    }
    check(
      'profile patch migration removes the stale plugin-manager disable',
      !!outcome && outcome.changed === true &&
        !fs.readFileSync(patchFile, 'utf8').includes('- id: plugin-manager') &&
        fs.readFileSync(patchFile, 'utf8').includes("host: '0.0.0.0'"),
      migrationRunError
        ? `${migrationRunError.message || migrationRunError}`
        : outcome
          ? `backup ${path.basename(outcome.backupPath || '')}`
          : 'no-op (unexpected — stale row was seeded)',
    );
  }
  try { fs.rmSync(migrationHome, { recursive: true, force: true }); } catch { /* best effort */ }

  // 4. dsh web startup + WebUI.
  if (await portInUse()) {
    check('port 3080 free before start', false, `127.0.0.1:${PORT} already in use — close other dsh instances`);
    process.exit(1);
  }
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
  const child = spawn(process.execPath, [CLI_ENTRY, 'web'], {
    cwd: DSH_DIR,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => (bootLog += d));
  child.stderr.on('data', (d) => (bootLog += d));

  const ready = await httpReady(`http://127.0.0.1:${PORT}/`, READY_TIMEOUT_MS);

  // BrowserAuth (0.1.2-alpha.1+): unauthenticated probes get 401/303. Wait
  // for the one-time launch token in the boot log, exchange it for the auth
  // cookie (the token endpoint answers 303 + Set-Cookie; the token is
  // single-use so redirect:'manual' — a follow would end 401), then read
  // the WebUI and drive the API with that cookie.
  let authCookie = '';
  if (ready) {
    authCookie = await new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        const m = bootLog.match(/token=([A-Za-z0-9_-]+)/);
        if (!m) {
          if (Date.now() - started > 30_000) { clearInterval(timer); resolve(''); }
          return;
        }
        clearInterval(timer);
        try {
          const boot = await fetch(`http://127.0.0.1:${PORT}/?token=${m[1]}`,
            { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          resolve((boot.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; '));
        } catch {
          resolve('');
        }
      }, 500);
    });
  }
  check('dsh web ready on 127.0.0.1:3080', ready, ready ? undefined : `timeout ${READY_TIMEOUT_MS / 1000}s`);

  let pageHasTitle = false;
  if (ready && authCookie) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, {
        headers: { cookie: authCookie },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      pageHasTitle = (await res.text()).includes('DeepSeek Harness');
    } catch {
      /* counted below */
    }
  }
  check('WebUI page served', ready && pageHasTitle,
    ready && pageHasTitle ? undefined
      : !ready ? 'server not ready' : authCookie ? 'missing <title>DeepSeek Harness</title>'
        : 'no auth cookie (launch token missing from boot log)');

  // 5. Agent-preset roster health — every shipped preset must compose clean.
  // The "waiting for <service>" mount-audit failures (see sidecar
  // patch-migration.ts) surface here as a preset row with `broken`.
  let rosterHealthy = false;
  let rosterDetail = !ready ? 'server not ready' : !authCookie ? 'no auth cookie' : 'roster probe failed';
  if (ready && authCookie) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/agentPresets/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: authCookie },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'smoke-roster',
          method: 'agentPresets/list', payload: { args: {} },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json();
      const rows = body?.result?.ok ? body?.result?.value?.presets : null;
      if (Array.isArray(rows)) {
        const brokenRows = rows.filter((r) => typeof r.broken === 'string');
        rosterHealthy = brokenRows.length === 0;
        rosterDetail = brokenRows.length === 0
          ? `${rows.length} presets clean`
          : brokenRows.map((r) => `${r.id}: ${r.broken}`).join('; ');
      } else {
        rosterDetail = `unexpected roster response (http ${res.status})`;
      }
    } catch (e) {
      rosterDetail = `roster probe failed: ${e && e.message || e}`;
    }
  }
  check('agent preset roster composes clean', rosterHealthy, rosterDetail);

  // 4. Lifecycle: SIGTERM reaps the tree, port released.
  child.kill('SIGTERM');
  const exited = await waitForExit(child, 15_000);
  check('dsh exits on SIGTERM', exited);
  await new Promise((r) => setTimeout(r, 2000));
  check('port released after exit', !(await portInUse()));

  if (!exited) child.kill('SIGKILL');
  try {
    fs.rmSync(dshHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  if (!ready || bootLog.length) {
    console.log('  --- dsh boot log (last 20 lines) ---');
    console.log(bootLog.trim().split('\n').slice(-20).map((l) => `  ${l}`).join('\n'));
  }

  console.log(failures === 0 ? '\n[smoke-test] ALL PASSED' : `\n[smoke-test] ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke-test] unexpected error:', e);
  process.exit(1);
});
