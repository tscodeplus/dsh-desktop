// Engine updater — runtime updates of the upstream DeepSeek Harness engine
// closure (dsh-dist + node_modules) at <DSHD_HOME>/engine.
//
// The engine is a built closure published as GitHub release assets under the
// fixed `engine` prerelease tag of this repo (see .github/workflows/
// engine-build.yml). The desktop app never builds on the user machine:
// check → download (resumable, SHA512-verified) → swap → health-check →
// rollback, all inside this sidecar process.
//
// User-facing copy says "DeepSeek Harness" (not "engine") — see i18n keys.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { x as extractTar } from 'tar';

import { broadcastEvent, postToShell, showWindow } from './control-server.js';
import { loadConfig } from './config.js';
import { DownloadCancelledError, DownloadProgress, downloadResumable } from './download.js';
import { getT } from './i18n.js';
import { fetchWithProxy } from './net.js';
import { compareVersions } from './updater.js';

// Fixed release tag of this repo that carries the engine assets + manifest.
// The manifest is the single source of truth for what is published (无状态:
// no CI-side state file — the app asks GitHub what the latest asset is).
const ENGINE_MANIFEST_URL =
  'https://github.com/tscodeplus/dsh-desktop/releases/download/engine/engine-manifest.json';

/** Provenance file written into the built closure by fetch-dsh.cjs. */
export interface EngineRef {
  ref: string;
  tag: string | null;
  upstreamVersion: string | null;
  platform: string;
  mode?: string;
  note?: string;
  builtAt?: string;
  cliEntry?: string | null;
}

/** One platform entry of engine-manifest.json. */
export interface EngineManifestEntry {
  ref: string;
  tag: string;
  version: string;
  file: string;
  url: string;
  sha512: string;
  size: number;
  builtAt?: string;
}

export interface EngineManifest {
  tag: string;
  updatedAt: string;
  platforms: Record<string, EngineManifestEntry>;
}

export type EngineState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready' // staged closure awaits a user-confirmed restart
  | 'installing'
  | 'error';

/** Full status the About page polls to render the inline update flow. */
export interface EngineStatus {
  current: EngineRef | null;
  available: EngineManifestEntry | null;
  state: EngineState;
  check: {
    state: 'idle' | 'checking' | 'done';
    result: 'none' | 'available' | 'uptodate' | 'error';
    message?: string;
  };
  download: {
    state: 'idle' | 'downloading' | 'done' | 'error';
    progress?: DownloadProgress;
    /** Localized failure label (e.g. "下载失败") — set when state='error'. */
    message?: string;
    /** Raw error text (e.g. "Download failed: HTTP 416") for diagnostics. */
    raw?: string;
  };
  install: {
    state: 'idle' | 'installing' | 'ready' | 'done' | 'error';
    message?: string;
    /** 0-100 extraction progress; absent when unmeasurable (the UI falls
     *  back to an indeterminate bar). */
    progress?: number;
  };
}

export interface EngineRuntimeDeps {
  /** <DSHD_HOME>/engine — the live engine closure home. */
  engineDir: string;
  /** Bundled install-dir closure home (same layout as engineDir — contains
   *  dsh-dist/ + node_modules/). dsh runs from here until the user's first
   *  engine update swaps a closure into ~/.dsh/engine. */
  bundledRoot: string;
  /** Kill the running dsh child (graceful SIGTERM → SIGKILL). */
  killDsh: () => Promise<void>;
  /** Respawn dsh from the given dsh-dist root (switched on engine swap). */
  respawn: (root: string) => void;
}

/** Platform key used in the manifest and in .engine-ref.json. */
export function currentPlatform(): string {
  if (process.platform === 'win32') return 'win32-x64';
  return `${process.platform}-${process.arch}`;
}

/** Read the engine provenance of a closure at <dir>/dsh-dist/.engine-ref.json. */
export function readEngineRef(engineDir: string): EngineRef | null {
  try {
    const p = path.join(engineDir, 'dsh-dist', '.engine-ref.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as EngineRef;
  } catch {
    return null;
  }
}

/** Parse engine-manifest.json text; returns the entry for `platform` or null. */
export function parseEngineManifest(
  text: string,
  platform: string,
): EngineManifestEntry | null {
  try {
    const m = JSON.parse(text) as EngineManifest;
    return m?.platforms?.[platform] ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide whether an update should be offered. ref equality always means no
 * update; otherwise the semver comparison decides (rc6 → rc7 offers an
 * update, re-built same version does not). If versions are missing/parse
 * failures, fall back to ref difference = update (conservative).
 */
export function decideEngineUpdate(
  current: EngineRef | null,
  available: EngineManifestEntry | null,
): { update: boolean; reason?: string } {
  if (!available) return { update: false, reason: 'no manifest entry' };
  if (!current?.ref) return { update: true };
  if (current.ref === available.ref) return { update: false, reason: 'same ref' };
  if (current.upstreamVersion && available.version) {
    // compareVersions returns NaN for unparseable input (no throw) — fall
    // back to ref difference then.
    const cmp = compareVersions(available.version, current.upstreamVersion);
    if (Number.isNaN(cmp)) return { update: true };
    if (cmp > 0) return { update: true };
    return { update: false, reason: 'published version not newer' };
  }
  return { update: true };
}

/** Engine diagnostic log — same file as the app updater (dshd-diag.log). */
function diagLog(msg: string): void {
  try {
    const home = process.env.DSHD_HOME ?? '.';
    const logsDir = path.join(home, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(logsDir, 'dshd-diag.log'), `[${ts}] [EngineUpdater] ${msg}\n`);
  } catch {
    /* best effort */
  }
}

function isDarkTheme(): boolean {
  try {
    const theme = loadConfig().theme;
    if (theme === 'light') return false;
    if (theme === 'dark') return true;
  } catch {
    /* fall through to OS */
  }
  return process.env.DSHD_OS_DARK === '1';
}

/** Poll GET http://127.0.0.1:{port}/ until it answers ok or the deadline hits. */
async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const port = Number(process.env.DSHD_PORT ?? 3080);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) return true;
    } catch {
      /* not up yet — retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dialog (single window, state-driven via SSE — no spinner/result dance)
// ---------------------------------------------------------------------------

type EngineDialogInitial =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'uptodate' }
  | { state: 'error'; message: string; raw: string };

function engineDialogHtml(initial: EngineDialogInitial): string {
  const t = getT().updater;
  // Inline the resolved locale into the page — the dialog is plain web
  // content and has no other way to get the sidecar's i18n.
  const L = {
    engineChecking: t.engineChecking,
    engineUpToDate: t.engineUpToDate,
    engineNewVersion: t.engineNewVersion,
    engineDownloading: t.engineDownloading,
    engineDownloaded: t.engineDownloaded,
    engineInstalling: t.engineInstalling,
    engineInstalled: t.engineInstalled,
    engineInstallFailed: t.engineInstallFailed,
    engineRolledBack: t.engineRolledBack,
    engineCancel: t.engineCancel,
    engineClose: t.engineClose,
    engineInstallNow: t.engineInstallNow,
    engineDownload: t.engineDownload,
    engineInstallReady: t.engineInstallReady,
    engineRestartNow: t.engineRestartNow,
    engineLater: t.engineLater,
    speed: t.speed,
  };
  const dark = isDarkTheme();
  const css = dark
    ? `body{background:#1e1e2e;color:#e6e6f0}.muted{color:#a6adc0}.btn{border:none;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;background:#4f8cff;color:#fff}.btn:hover{background:#6b9cff}.btn.sec{background:#22233a;color:#e6e6f0}.bar{height:6px;background:#2a2b3d;border-radius:3px;overflow:hidden}.bar>div{height:100%;background:#4f8cff;width:0%}`
    : `body{background:#f8fafc;color:#1e2430}.muted{color:#667085}.btn{border:none;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;background:#3b5bdb;color:#fff}.btn:hover{background:#364fc7}.btn.sec{background:#eef1f6;color:#1e2430}.bar{height:6px;background:#e6e8ee;border-radius:3px;overflow:hidden}.bar>div{height:100%;background:#3b5bdb;width:0%}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;height:100vh;display:flex;flex-direction:column;padding:18px 22px;user-select:none}
h2{font-size:14px;margin-bottom:6px}
p{font-size:13px;line-height:1.5}
${css}
</style></head><body>
<h2 id="title"></h2>
<p id="status" class="muted"></p>
<div id="bar-wrap" style="display:none;margin-top:10px"><div class="bar"><div id="bar"></div></div>
<p id="speed" class="muted" style="font-size:11px;margin-top:4px"></p></div>
<div id="err" style="display:none;margin-top:10px;font-size:12px;color:#e5484d;word-break:break-all"></div>
<div id="actions" style="display:flex;gap:8px;margin-top:auto;padding-top:14px">
  <button class="btn sec" id="btn-close"></button>
  <button class="btn" id="btn-primary" style="display:none"></button>
  <button class="btn sec" id="btn-secondary" style="display:none"></button>
</div>
<script>
(function () {
  var L = ${JSON.stringify(L)};
  function set(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function show(id) { document.getElementById(id).style.display = ''; }
  function hide(id) { document.getElementById(id).style.display = 'none'; }
  var primary = document.getElementById('btn-primary');
  var secondary = document.getElementById('btn-secondary');
  function state(statusText, primaryLabel, primaryAction, secondaryLabel, secondaryAction) {
    set('title', 'DeepSeek Harness');
    set('status', statusText || '');
    hide('bar-wrap'); hide('err');
    if (primaryLabel && primaryAction) { show('btn-primary'); primary.textContent = primaryLabel; primary.onclick = primaryAction; }
    else hide('btn-primary');
    if (secondaryLabel && secondaryAction) { show('btn-secondary'); secondary.textContent = secondaryLabel; secondary.onclick = secondaryAction; }
    else hide('btn-secondary');
  }
  var d = window.__dshDialog;
  document.getElementById('btn-close').textContent = L.engineClose;
  document.getElementById('btn-close').onclick = function () { d.close(); };
  d.onEngineAvailable(function (ev) {
    state(L.engineNewVersion.replace('{{version}}', ev.version || ''), L.engineDownload, function () { d.engineDownload(); }, L.engineClose, function () { d.close(); });
  });
  d.onEngineNotAvailable(function () {
    state(L.engineUpToDate, null, null, L.engineClose, function () { d.close(); });
  });
  d.onEngineDownloadProgress(function (p) {
    show('bar-wrap');
    document.getElementById('bar').style.width = (p.percent || 0) + '%';
    set('speed', L.speed + ': ' + Math.round(p.bytesPerSecond / 1024) + ' KB/s');
    state(L.engineDownloading, null, null, L.engineCancel, function () { d.engineCancel(); });
  });
  d.onEngineDownloaded(function () {
    hide('bar-wrap');
    state(L.engineDownloaded, L.engineInstallNow, function () { d.engineInstall(); }, L.engineClose, function () { d.close(); });
  });
  d.onEngineInstalling(function (ev) {
    // restartUpdate broadcasts a "Restarting…" message — show it; the plain
    // extraction flow keeps the generic "Installing…" label.
    state((ev && ev.message) || L.engineInstalling, null, null, L.engineClose, function () { d.close(); });
  });
  d.onEngineInstallProgress(function (ev) {
    show('bar-wrap');
    document.getElementById('bar').style.width = (ev.percent || 0) + '%';
    state(L.engineInstalling, null, null, L.engineClose, function () { d.close(); });
  });
  d.onEngineInstallReady(function (ev) {
    hide('bar-wrap');
    state(L.engineInstallReady, L.engineRestartNow, function () { d.engineRestart(); }, L.engineLater, function () { d.close(); });
  });
  d.onEngineInstalled(function (ev) {
    state(L.engineInstalled.replace('{{version}}', ev.version || ''), null, null, L.engineClose, function () { d.close(); });
  });
  d.onEngineError(function (ev) {
    show('err'); set('err', ev.raw || '');
    state(ev.message || L.engineInstallFailed, null, null, L.engineClose, function () { d.close(); });
  });
  var INIT = ${JSON.stringify(initial)};
  if (INIT.state === 'available') {
    state(L.engineNewVersion.replace('{{version}}', INIT.version || ''), L.engineDownload, function () { d.engineDownload(); }, L.engineClose, function () { d.close(); });
  } else if (INIT.state === 'uptodate') {
    state(L.engineUpToDate, null, null, L.engineClose, function () { d.close(); });
  } else if (INIT.state === 'error') {
    show('err'); set('err', INIT.raw || '');
    state(INIT.message || L.engineInstallFailed, null, null, L.engineClose, function () { d.close(); });
  } else {
    state(L.engineChecking, null, null, L.engineClose, function () { d.close(); });
  }
})();
</script></body></html>`;
}

// ---------------------------------------------------------------------------
// EngineUpdater
// ---------------------------------------------------------------------------

class EngineUpdater {
  private state: EngineState = 'idle';
  private current: EngineRef | null;
  private available: EngineManifestEntry | null = null;
  private downloadedPath: string | null = null;
  private downloadCancelled = false;
  private checking = false;
  private checkResult: EngineStatus['check'] = { state: 'idle', result: 'none' };
  private downloadState: EngineStatus['download'] = { state: 'idle' };
  private installState: EngineStatus['install'] = { state: 'idle' };

  constructor(private deps: EngineRuntimeDeps) {
    // The running engine is either the user-updated closure at ~/.dsh/engine
    // or (no update yet) the bundled install-dir closure — read whichever
    // actually runs, so an up-to-date bundled seed is not flagged as stale.
    this.current = readEngineRef(deps.engineDir) ?? readEngineRef(deps.bundledRoot);
    diagLog(
      `init: engine at ${deps.engineDir} — ${this.current ? this.current.ref.slice(0, 12) : 'no ref'}`,
    );
  }

  status(): EngineStatus {
    return {
      current: this.current,
      available: this.available,
      state: this.state,
      check: this.checkResult,
      download: this.downloadState,
      install: this.installState,
    };
  }

  /** Fetch the manifest and compare against the local engine. Sends SSE
   *  engine-* events and records the outcome in `check` for the About page's
   *  inline flow. `popup` (startup silent check) opens the result dialog
   *  when an update is available; the About-page button (popup:false) renders
   *  the same states inline instead. */
  async checkForUpdate(opts: { popup?: boolean } = {}): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.state = 'checking';
    this.checkResult = { state: 'checking', result: 'none' };
    try {
      const resp = await fetchWithProxy(ENGINE_MANIFEST_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status === 404) {
        // No engine release yet (first install) — quiet no-update.
        diagLog('check: no engine release (404)');
        this.state = 'idle';
        this.checkResult = { state: 'done', result: 'none' };
        broadcastEvent('engine-not-available', {});
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const entry = parseEngineManifest(await resp.text(), currentPlatform());
      const decision = decideEngineUpdate(this.current, entry);
      diagLog(`check: ${decision.update ? 'update available' : `no update (${decision.reason})`}`);
      if (decision.update && entry) {
        this.available = entry;
        this.state = 'available';
        this.checkResult = { state: 'done', result: 'available' };
        broadcastEvent('engine-available', {
          version: entry.version,
          ref: entry.ref,
          size: entry.size,
        });
        // Silent discovery must surface to the user for confirmation before
        // any download happens — the startup check pops the dialog, the
        // About-page button shows the same state inline.
        if (opts.popup) {
          showWindow('engine-updater', engineDialogHtml({ state: 'available', version: entry.version }), 480, 360, isDarkTheme());
        }
      } else {
        this.available = null;
        this.state = 'idle';
        this.checkResult = { state: 'done', result: 'uptodate' };
        broadcastEvent('engine-not-available', {});
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diagLog(`check failed: ${msg}`);
      this.state = 'error';
      this.checkResult = { state: 'done', result: 'error', message: msg };
      broadcastEvent('engine-error', {
        message: getT().updater.checkFailed,
        raw: msg,
      });
    } finally {
      this.checking = false;
    }
  }

  /** Download the available asset (resumable, SHA512-verified) to
   *  <DSHD_HOME>/downloads. Sends engine-download-progress / -downloaded. */
  async downloadUpdate(): Promise<void> {
    if (!this.available) {
      diagLog('download: no available update');
      return;
    }
    this.state = 'downloading';
    this.downloadCancelled = false;
    this.downloadState = { state: 'downloading' };
    try {
      const downloadsDir = path.join(process.env.DSHD_HOME ?? os.homedir(), 'downloads');
      const { path: filePath } = await downloadResumable({
        url: this.available.url,
        destDir: downloadsDir,
        fileName: this.available.file,
        versionMarker: this.available.ref,
        sha512: this.available.sha512,
        shouldCancel: () => this.downloadCancelled,
        onProgress: (p) => {
          this.downloadState = { state: 'downloading', progress: p };
          broadcastEvent('engine-download-progress', p);
        },
        log: (m) => diagLog(`download: ${m}`),
      });
      this.downloadedPath = filePath;
      this.state = 'available';
      this.downloadState = { state: 'done' };
      broadcastEvent('engine-downloaded', {
        version: this.available.version,
        path: filePath,
      });
    } catch (e) {
      if (e instanceof DownloadCancelledError) {
        diagLog('download: cancelled by user');
        this.state = 'available';
        this.downloadState = { state: 'idle' };
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      diagLog(`download failed: ${msg}`);
      this.state = 'error';
      this.downloadState = {
        state: 'error',
        message: getT().updater.downloadFailed,
        raw: msg,
      };
      broadcastEvent('engine-error', {
        message: getT().updater.downloadFailed,
        raw: msg,
      });
    }
  }

  cancelDownload(): void {
    this.downloadCancelled = true;
  }

  /** One-step "Download & Install": download the update, then swap + restart
   *  immediately — no separate user-confirmed restart step in between (the
   *  About page offers a single combined action). Cancel still aborts the
   *  download phase; once the install begins it is not cancellable. */
  async downloadAndInstall(): Promise<void> {
    await this.downloadUpdate();
    if (this.state === 'error' || this.downloadState.state !== 'done') {
      // Download failed or cancelled — the UI already reflects that state.
      return;
    }
    await this.installUpdate();
    if (this.installState.state === 'ready') {
      await this.restartUpdate();
    }
  }

  /** Extract the downloaded tarball into engine.staging and verify the
   *  closure — WITHOUT touching the live engine. The user then confirms the
   *  restart (they may be running tasks; an auto-restart would hard-stop
   *  them). The swap happens in restartUpdate() (user-confirmed) or at next
   *  boot via applyPendingEngineStaging() (dsh not running — no interruption). */
  async installUpdate(): Promise<void> {
    if (this.state === 'installing' || this.state === 'ready') return;
    if (!this.available || !this.downloadedPath) {
      diagLog('install: nothing to install');
      return;
    }
    this.state = 'installing';
    this.installState = { state: 'installing' };
    broadcastEvent('engine-installing', { version: this.available.version });

    const engineDir = this.deps.engineDir;
    const homeDir = path.dirname(engineDir);
    const stagingDir = path.join(homeDir, 'engine.staging');
    const t = getT().updater;

    try {
      // Coarse free-space check: staging + the live engine coexist briefly.
      const free = fs.statfsSync(homeDir).bavail * fs.statfsSync(homeDir).bsize;
      const need = this.available.size * 2.5;
      if (free < need) {
        throw new Error(
          `not enough free space (${Math.round(free / 1e6)}MB free, need ~${Math.round(need / 1e6)}MB)`,
        );
      }

      // 1. Extract into staging, reporting progress per entry. Pre-scan the
      // entry count first (best effort — if it fails, the UI shows an
      // indeterminate bar instead of a percentage).
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true });
      diagLog(`install: extracting ${this.downloadedPath} → ${stagingDir}`);
      let totalEntries = 0;
      try {
        await extractTar({
          file: this.downloadedPath,
          filter: () => {
            totalEntries++;
            return false; // count only — nothing to write
          },
        });
      } catch {
        totalEntries = 0; // unmeasurable — indeterminate bar in the UI
      }
      let doneEntries = 0;
      await extractTar({
        file: this.downloadedPath,
        cwd: stagingDir,
        unlink: true,
        onentry: () => {
          if (totalEntries <= 0) return;
          doneEntries++;
          const pct = Math.min(85, Math.round((doneEntries / totalEntries) * 85));
          this.installState = { state: 'installing', progress: pct };
          broadcastEvent('engine-install-progress', { percent: pct });
        },
      });

      // 2. Verify the staged closure before touching the live one.
      const stagedRef = readEngineRef(stagingDir);
      if (!stagedRef) throw new Error('staged closure missing .engine-ref.json');
      if (stagedRef.ref !== this.available.ref) {
        throw new Error(`ref mismatch: staged ${stagedRef.ref} != manifest ${this.available.ref}`);
      }
      if (stagedRef.platform !== currentPlatform()) {
        throw new Error(
          `platform mismatch: staged ${stagedRef.platform} != ${currentPlatform()}`,
        );
      }
      const binJs = path.join(stagingDir, 'dsh-dist', 'apps', 'cli', 'lib', 'bin.js');
      if (!fs.existsSync(binJs)) throw new Error('staged closure missing CLI entry');
      diagLog(`install: staged closure ok (${stagedRef.ref.slice(0, 12)})`);

      // 3. Staged and verified — stop here. The live engine keeps running;
      // the swap needs the user's confirmation (restartUpdate) or the next
      // app boot (applyPendingEngineStaging).
      this.installState = { state: 'ready', progress: 100 };
      this.state = 'ready';
      diagLog('install: staged, awaiting user-confirmed restart');
      broadcastEvent('engine-install-ready', {
        version: stagedRef.upstreamVersion ?? stagedRef.tag ?? stagedRef.ref.slice(0, 12),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diagLog(`install failed: ${msg}`);
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
      this.state = 'error';
      this.installState = { state: 'error', message: t.engineInstallFailed };
      broadcastEvent('engine-error', { message: t.engineInstallFailed, raw: msg });
    }
  }

  /** Apply a staged update: swap engine.staging → engine, respawn dsh and
   *  health-check it, rolling back on failure. Only ever called by the
   *  user-confirmed restart (POST /_desktop/engine/restart) — never
   *  automatically, so running tasks are not interrupted behind the user's
   *  back. */
  async restartUpdate(): Promise<void> {
    if (this.state === 'installing') return;
    if (this.installState.state !== 'ready') {
      diagLog('restart: no staged update');
      return;
    }
    const t = getT().updater;
    this.state = 'installing';
    // No fake percentage here: the swap (kill → rename → respawn) plus the
    // health check takes a few seconds with no measurable progress — show
    // "Restarting…" (indeterminate in the UI) instead of a stuck 90%.
    this.installState = { state: 'installing', message: t.engineRestarting };
    broadcastEvent('engine-installing', {
      version: this.available?.version ?? '',
      message: t.engineRestarting,
    });

    const engineDir = this.deps.engineDir;
    const homeDir = path.dirname(engineDir);
    const stagingDir = path.join(homeDir, 'engine.staging');
    const prevDir = path.join(homeDir, 'engine.prev');
    const stagedRef = readEngineRef(stagingDir);

    try {
      if (!stagedRef) throw new Error('staged closure missing .engine-ref.json');

      // 1. Swap: shell health loop to Starting, kill dsh, rename triple.
      //    On the FIRST update there is no live closure at ~/.dsh/engine yet
      //    (dsh runs from the bundled install dir) — live → prev is skipped,
      //    and there is nothing to restore on failure.
      await postToShell('/engine-swap-begin', {});
      await this.deps.killDsh();
      const liveExists = fs.existsSync(engineDir);
      fs.rmSync(prevDir, { recursive: true, force: true });
      if (liveExists) fs.renameSync(engineDir, prevDir); // live → prev
      try {
        fs.renameSync(stagingDir, engineDir); // staging → live
      } catch (e) {
        if (liveExists) {
          try {
            fs.renameSync(prevDir, engineDir); // restore
          } catch {
            /* engine.prev left as recovery marker — next boot cleans up */
          }
        }
        throw e;
      }

      // 2. Respawn and health-check the new engine.
      this.deps.respawn(path.join(engineDir, 'dsh-dist'));
      if (await waitForHealth(45_000)) {
        this.current = stagedRef;
        this.state = 'idle';
        this.installState = { state: 'done', message: stagedRef.upstreamVersion ?? stagedRef.tag ?? stagedRef.ref.slice(0, 12) };
        diagLog(`restart: OK, engine now ${stagedRef.ref.slice(0, 12)}`);
        broadcastEvent('engine-installed', {
          version: stagedRef.upstreamVersion ?? stagedRef.tag ?? stagedRef.ref.slice(0, 12),
        });
        // Best-effort prev cleanup.
        fs.rmSync(prevDir, { recursive: true, force: true });
        return;
      }

      // 3. Rollback: kill the new engine, restore the previous closure, fresh
      //    startup window. Without a previous closure (first update), the
      //    bundled install-dir closure takes over again.
      diagLog('restart: new engine failed health check — rolling back');
      await this.deps.killDsh();
      fs.rmSync(engineDir, { recursive: true, force: true });
      if (liveExists) {
        fs.renameSync(prevDir, engineDir);
      } else {
        diagLog('restart: rollback — no previous closure, back to bundled install dir');
      }
      await postToShell('/engine-swap-begin', {});
      this.deps.respawn(
        liveExists ? path.join(engineDir, 'dsh-dist') : path.join(this.deps.bundledRoot, 'dsh-dist'),
      );
      if (await waitForHealth(60_000)) {
        this.state = 'idle';
        this.installState = { state: 'error', message: t.engineRolledBack };
        broadcastEvent('engine-error', {
          message: t.engineRolledBack,
          raw: 'health check failed after restart; rolled back to previous version',
        });
      } else {
        this.state = 'error';
        this.installState = { state: 'error', message: t.engineInstallFailed };
        broadcastEvent('engine-error', {
          message: t.engineInstallFailed,
          raw: 'rollback respawn also failed to recover the service',
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diagLog(`restart failed: ${msg}`);
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
      this.state = 'error';
      this.installState = { state: 'error', message: t.engineInstallFailed };
      broadcastEvent('engine-error', { message: t.engineInstallFailed, raw: msg });
    }
  }
}

/**
 * Apply a staged engine update at boot, before dsh spawns: swap
 * engine.staging → engine while nothing is running — no interruption, no
 * health check needed. Called from index.ts after ensureEngine(); returns
 * true when a staged update was applied. A corrupt staging is discarded so
 * the live engine stays untouched.
 */
export function applyPendingEngineStaging(engineDir: string): boolean {
  const homeDir = path.dirname(engineDir);
  const stagingDir = path.join(homeDir, 'engine.staging');
  const prevDir = path.join(homeDir, 'engine.prev');
  if (!fs.existsSync(stagingDir)) return false;
  try {
    const stagedRef = readEngineRef(stagingDir);
    const binJs = path.join(stagingDir, 'dsh-dist', 'apps', 'cli', 'lib', 'bin.js');
    if (!stagedRef || !fs.existsSync(binJs)) {
      diagLog('applyPendingStaging: invalid staged closure — discarding');
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return false;
    }
    fs.rmSync(prevDir, { recursive: true, force: true });
    // First update: no live closure at ~/.dsh/engine yet (dsh runs from the
    // bundled install dir) — skip live → prev, nothing to preserve.
    if (fs.existsSync(engineDir)) fs.renameSync(engineDir, prevDir); // live → prev
    fs.renameSync(stagingDir, engineDir); // staging → live
    fs.rmSync(prevDir, { recursive: true, force: true });
    diagLog(`applyPendingStaging: applied staged engine ${stagedRef.ref.slice(0, 12)}`);
    return true;
  } catch (e) {
    diagLog(`applyPendingStaging failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

let singleton: EngineUpdater | null = null;

/** Wire the engine updater (called once from index.ts after the control
 *  server is up). Idempotent. */
export function initEngineUpdater(deps: EngineRuntimeDeps): EngineUpdater {
  singleton ??= new EngineUpdater(deps);
  return singleton;
}

export function getEngineUpdater(): EngineUpdater {
  if (!singleton) {
    throw new Error('engine updater not initialized — call initEngineUpdater first');
  }
  return singleton;
}
