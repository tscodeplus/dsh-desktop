// DSH Desktop sidecar entry — runs the dsh (DeepSeek Harness)
// web server as a child process, spawned by the Tauri shell.
//
// Unlike OhMyAgent (whose gateway was imported in-process via bootstrap()),
// dsh is a standalone CLI app, so the sidecar *spawns* it:
//   · prod: `<bundled-node> <root>/dsh-dist/apps/cli/lib/bin.js web` with
//           cwd = dsh-dist (the built upstream checkout); DSH_HOME → app
//           data. The engine runs from the bundled install-dir closure
//           (DSHD_RESOURCES_DIR) until the user's first engine update swaps
//           a closure into <DSHD_HOME>/engine (engine-updater.ts).
//   · dev:  `pnpm dsh web` in DSHD_DEV_ROOT (dsh source checkout, tsx-based)
//
// Then serve the control API + heartbeat until shutdown, killing dsh on exit.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createControlServer,
  ensureDataDirs,
  startHeartbeat,
} from './control-server.js';
import {
  applyPendingEngineStaging,
  getEngineUpdater,
  initEngineUpdater,
} from './engine-updater.js';
import { repairProfilesModuleFallback } from './fallback-repair.js';

const isDev = process.env.DSHD_DEV === '1';
const resourcesDir = process.env.DSHD_RESOURCES_DIR ?? process.cwd();
const dshHome = process.env.DSHD_HOME ?? join(homedir(), '.dsh');
// The engine closure home. Same volume as the data root so engine updates
// can swap directories atomically (see engine-updater.ts installUpdate).
const engineDir = join(dshHome, 'engine');
const engineDist = join(engineDir, 'dsh-dist');
const dshPort = process.env.DSHD_PORT ?? '3080';

// Resolved after ensureEngine(): where dsh is spawned from.
let dshRoot = isDev ? (process.env.DSHD_DEV_ROOT ?? resourcesDir) : join(resourcesDir, 'dsh-dist');

/**
 * Resolve where dsh runs from. There is NO seed copy at install time: the
 * bundled install-dir closure (DSHD_RESOURCES_DIR) is used as-is until the
 * user's first engine update swaps a fresh closure into ~/.dsh/engine
 * (engine-updater.ts). Idempotent; NEVER blocks startup.
 */
function ensureEngine(): void {
  if (isDev) return;
  if (existsSync(join(engineDist, 'apps', 'cli', 'lib', 'bin.js'))) {
    // User-updated engine — leftovers from an interrupted swap get cleaned
    // opportunistically.
    try {
      rmSync(join(dshHome, 'engine.prev'), { recursive: true, force: true });
      rmSync(join(dshHome, 'engine.staging'), { recursive: true, force: true });
    } catch {
      /* ok */
    }
    dshRoot = engineDist;
    console.log(`[sidecar] engine: user-updated closure at ${engineDir}`);
    return;
  }
  dshRoot = join(resourcesDir, 'dsh-dist');
  console.log('[sidecar] engine: bundled install-dir closure (no user update yet)');
}

// 1. Data dir (idempotent; prod shell also pre-creates it).
ensureDataDirs();

// 2. Engine root resolution (bundled closure vs user-updated), then spawn.
ensureEngine();
// A staged update (user picked "Later" last run) is applied here, before dsh
// spawns — nothing is running, so the swap cannot interrupt any task. When
// applied, dsh switches from the bundled closure to the staged one.
if (!isDev && applyPendingEngineStaging(engineDir)) {
  dshRoot = engineDist;
}

let dshChild: ChildProcess | null = null;

/**
 * Shared exit bookkeeping for a spawned dsh child. With `--no-open` there is
 * one extra duty: pre-rc8 closures reject the unknown option and exit 1
 * immediately, so respawn without the flag to keep the old engine running.
 * Guarded by dshChild identity so a later respawn can't double-retry.
 */
function watchDsh(child: ChildProcess, noOpen: boolean): ChildProcess {
  child.on('error', (err) => {
    console.error('[sidecar] dsh spawn error:', err);
  });
  child.on('exit', (code, signal) => {
    console.log(`[sidecar] dsh exited (code=${code}, signal=${signal})`);
    // Only a clean unknown-option exit (code 1, no signal) triggers the
    // fallback — signal deaths (e.g. engine-swap SIGTERM) must not respawn.
    if (noOpen && code === 1 && signal === null && dshChild === child) {
      console.log('[sidecar] dsh rejected --no-open (pre-rc8 closure?) — retrying without it');
      dshChild = watchDsh(spawnDshWeb(['web']), false);
      return;
    }
    dshChild = null;
  });
  return child;
}

/** Spawn the prod CLI bundle (`apps/cli/lib/bin.js`) with the given args. */
function spawnDshWeb(webArgs: string[]): ChildProcess {
  const entry = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
  return spawn(process.execPath, [entry, ...webArgs], {
    cwd: dshRoot,
    env: dshEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function spawnDsh(): ChildProcess {
  // Pre-flight: the dsh boot's fallback health check refuses any real (non-
  // symlink) entry under <home>/profiles/node_modules and exits code 1 — a
  // stale EMPTY real dir (an interrupted first-boot link creation) would make
  // dsh crash forever at every start. Remove such leftovers so dsh re-links.
  try {
    const removed = repairProfilesModuleFallback(dshHome);
    if (removed.length > 0) {
      console.log(`[sidecar] profiles fallback: removed stale dirs: ${removed.join(', ')}`);
    }
  } catch (e) {
    console.error('[sidecar] profiles fallback repair failed:', e);
  }
  console.log(`[sidecar] starting dsh web (dev=${isDev}, root=${dshRoot})`);
  if (isDev) {
    // Dev: run exactly like upstream `pnpm dsh web` (tsx loader, src entry).
    return watchDsh(
      spawn('pnpm', ['dsh', 'web'], {
        cwd: dshRoot,
        shell: process.platform === 'win32',
        env: dshEnv(),
        stdio: ['ignore', 'inherit', 'inherit'],
      }),
      false,
    );
  }
  // Prod: the built CLI bundle (tsdown output) runs on the bundled Node.
  // Since rc8, `dsh web` opens the default browser once the server is ready
  // (upstream CLI behavior) — the desktop shell IS the browser, so the
  // handoff must ALWAYS be suppressed, no matter what the closure looks
  // like (a per-closure version probe can misread a mid-install or stale
  // closure and let the browser pop on the first launch). Pre-rc8 closures
  // reject the unknown option and exit 1; watchDsh respawns without it.
  return watchDsh(spawnDshWeb(['web', '--no-open']), true);
}

/** (Re)spawn dsh — used at boot and by engine-updater.ts after a swap. */
export function respawnDsh(): ChildProcess {
  dshChild = spawnDsh();
  return dshChild;
}

/** Gracefully stop the dsh child WITHOUT exiting the sidecar process
 *  (engine-updater.ts swaps the engine closure in this window). */
export async function stopDshChild(reason: string): Promise<void> {
  const child = dshChild;
  if (!child || child.killed) return;
  console.log(`[sidecar] stopping dsh (${reason})`);
  child.kill('SIGTERM');
  // Give dsh a moment to flush; hard-kill on timeout (the child may have
  // spawned workers holding the ports / files to be swapped).
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (dshChild && !dshChild.killed) {
    child.kill('SIGKILL');
  }
}

function dshEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // dsh profile/data home — the shell passes the app-data dir as DSHD_HOME.
    DSH_HOME: process.env.DSHD_HOME ?? undefined,
    // Telemetry off by default for a desktop app (any non-empty value disables).
    DSH_TELEMETRY_DISABLED: '1',
  };
}

dshChild = spawnDsh();

// 3. Control API (before anything else so shutdown is always reachable).
const controlPort = Number(process.env.DSHD_SIDECAR_CONTROL_PORT ?? 9291);
const controlToken = process.env.DSHD_CONTROL_TOKEN ?? 'dev';
const controlServer = createControlServer({
  port: controlPort,
  token: controlToken,
  stop: async () => {
    await stopDsh('control');
  },
});

// 4. Engine updater (needs the control API's engine routes up; the updater
// itself only reads refs at init). Startup silent check: after 25s, fetch
// the engine manifest; a newer DeepSeek Harness prompts (never auto-installs).
// TEMPORARILY DISABLED (product decision 2026-08-19): updates surface only
// from the About page's manual check. Flip ENGINE_STARTUP_CHECK_ENABLED to
// re-enable the popup flow — the code is fully wired and tested.
const ENGINE_STARTUP_CHECK_ENABLED = false;
initEngineUpdater({
  engineDir,
  bundledRoot: resourcesDir,
  killDsh: () => stopDshChild('engine-swap'),
  respawn: (root) => {
    dshRoot = root;
    respawnDsh();
  },
});
if (ENGINE_STARTUP_CHECK_ENABLED && !isDev) {
  setTimeout(() => {
    getEngineUpdater()
      .checkForUpdate({ popup: true })
      .catch((e: unknown) => {
        console.error('[sidecar] engine update check failed:', e);
      });
  }, 25_000);
}

// 5. Heartbeat to the shell's control service (anti-orphan). The heartbeat
// also reports the control API port actually bound — the reserved port can
// shift (race / TIME_WAIT), and the shell must track the live one.
const ctlPort = Number(process.env.DSHD_DESKTOP_CONTROL_PORT ?? 0);
if (ctlPort > 0) {
  // Anti-orphan exit MUST kill the dsh child first (see control-server.ts
  // startHeartbeat docs) — otherwise a hard-killed shell leaves dsh holding
  // port 3080 forever (macOS/Linux have no Windows kill-on-close job object).
  startHeartbeat(ctlPort, controlToken, controlPort, () => {
    void stopDsh('shell-unreachable');
  });
}

console.log(`[sidecar] dsh web on 127.0.0.1:${dshPort} (control api :${controlPort})`);

// 6. Shutdown — kill the dsh child (graceful SIGTERM, then SIGKILL).
let shuttingDown = false;
async function stopDsh(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sidecar] shutdown (${reason})`);
  const forceExit = setTimeout(() => {
    console.error(`[sidecar] stop() timed out (${reason}) — forcing exit`);
    process.exit(0);
  }, 5000);
  forceExit.unref?.();
  try {
    controlServer.close();
    const child = dshChild;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // Give dsh a moment to flush; hard-kill on timeout is handled by the
      // force-exit above (the OS reaps the child with the process group).
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (dshChild && !dshChild.killed) {
        child.kill('SIGKILL');
      }
    }
  } catch (e) {
    console.error('[sidecar] stop() error:', e);
  }
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGINT', () => void stopDsh('SIGINT'));
process.on('SIGTERM', () => void stopDsh('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[sidecar] uncaught exception:', e);
});
