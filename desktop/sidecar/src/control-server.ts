// Sidecar control API — a small HTTP server on 127.0.0.1 that the Rust shell
// (health lifecycle / tray) talks to. Token-gated (Authorization: Bearer or
// ?token= for EventSource) with CORS for the WebUI origin.
//
// Endpoints:
//   GET    /_desktop/ping                     → "pong"
//   GET    /_desktop/config?key=theme         → { key, value }
//   PUT    /_desktop/config   {key, value}
//   PUT    /_desktop/language  {lang}
//   GET    /_desktop/user-data-path           → { path }
//   GET    /_desktop/events                   → SSE (updater events)
//   POST   /_desktop/updater/check|download|cancel|install
//   POST   /_desktop/dialog/close  {kind}     → close an updater dialog window
//   GET    /_desktop/pages/updater/:kind      → HTML (dialog windows — cached
//                                                by updater.ts via cachePage,
//                                                loaded by Rust webview windows)
//   GET    /_desktop/plugin/list              → installed plugins (web profile)
//   POST   /_desktop/plugin/install|remove|update  {spec|name, restart?} → {jobId}
//   GET    /_desktop/plugin/status/:job       → { job } (running job + output)
//   POST   /_desktop/plugin/cancel/:job       → kill the pnpm process tree
//   POST   /_desktop/plugin/restart           → shell respawns the dsh service
//   GET    /_desktop/pages/plugin-manager     → HTML (plugin-manager window)
//   POST   /_desktop/shutdown                 → graceful stop + exit

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, saveConfig, type DesktopConfig } from './config.js';

export interface ControlServerOptions {
  port: number;
  token: string;
  /** Shutdown hook wired to bootstrap().stop() */
  stop: () => Promise<void>;
}

/**
 * How long to wait for the graceful stop() before force-exiting. stop() can
 * hang indefinitely: its server.close() waits for lingering SSE/keep-alive
 * connections (the WebUI keeps one open), so without a deadline the process
 * never exits and the respawn crashes with EADDRINUSE on the control port.
 */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** Updater event emitter consumed by control-server SSE + updater module. */
export const updaterEvents = new EventEmitter();

/**
 * Latest HTML per updater-dialog kind. Rust builds those windows with a real
 * http://127.0.0.1:{port}/_desktop/pages/updater/{kind} URL (data: URLs are
 * rejected by the remote-origin ACL), so the page must be served from here.
 */
const updaterPages = new Map<string, string>();

/** Cache the dialog HTML for the given kind (called by updater.ts /
 *  engine-updater.ts via showWindow). */
export function cachePage(kind: string, html: string): void {
  updaterPages.set(kind, html);
}

/**
 * Dialog window shim — the updater/engine dialog pages are plain web content
 * served from the sidecar control API (same origin), so their buttons talk to
 * the control API directly (token from the window URL). Window close goes
 * sidecar → shell control service (`POST /close-window`), which closes the
 * Rust window. Extended with engine-* actions/events for the engine update
 * dialog; existing dialogs are unaffected (unused listeners never fire).
 */
export function withDialogShim(kind: string, html: string): string {
  const shim = `<script>
window.__DSHD_DIALOG_KIND = ${JSON.stringify(kind)};
(function () {
  var q = new URLSearchParams(location.search);
  var token = q.get('token') || '';
  var base = location.origin;
  function ctl(path, body) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetch(base + path + sep + 'token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}'
    }).catch(function () {});
  }
  var listeners = {
    'update-download-progress': [],
    'update-downloaded': [],
    'update-error': []
  };
  var engineListeners = {
    'engine-available': [],
    'engine-not-available': [],
    'engine-download-progress': [],
    'engine-downloaded': [],
    'engine-installing': [],
    'engine-install-progress': [],
    'engine-install-ready': [],
    'engine-installed': [],
    'engine-error': []
  };
  function on(list, type, e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    list[type].forEach(function (f) { f(data); });
  }
  var es = new EventSource(base + '/_desktop/events?token=' + encodeURIComponent(token));
  es.addEventListener('update-download-progress', function (e) { on(listeners, 'update-download-progress', e); });
  es.addEventListener('update-downloaded', function (e) { on(listeners, 'update-downloaded', e); });
  es.addEventListener('update-error', function (e) { on(listeners, 'update-error', e); });
  es.addEventListener('engine-available', function (e) { on(engineListeners, 'engine-available', e); });
  es.addEventListener('engine-not-available', function (e) { on(engineListeners, 'engine-not-available', e); });
  es.addEventListener('engine-download-progress', function (e) { on(engineListeners, 'engine-download-progress', e); });
  es.addEventListener('engine-downloaded', function (e) { on(engineListeners, 'engine-downloaded', e); });
  es.addEventListener('engine-installing', function (e) { on(engineListeners, 'engine-installing', e); });
  es.addEventListener('engine-install-progress', function (e) { on(engineListeners, 'engine-install-progress', e); });
  es.addEventListener('engine-install-ready', function (e) { on(engineListeners, 'engine-install-ready', e); });
  es.addEventListener('engine-installed', function (e) { on(engineListeners, 'engine-installed', e); });
  es.addEventListener('engine-error', function (e) { on(engineListeners, 'engine-error', e); });
  window.__dshDialog = {
    close: function () { ctl('/_desktop/dialog/close', { kind: window.__DSHD_DIALOG_KIND || '' }); },
    downloadUpdate: function () { ctl('/_desktop/updater/download'); },
    cancelDownload: function () { ctl('/_desktop/updater/cancel'); },
    installUpdate: function () { ctl('/_desktop/updater/install'); },
    onUpdateDownloadProgress: function (f) { listeners['update-download-progress'].push(f); },
    onUpdateDownloaded: function (f) { listeners['update-downloaded'].push(f); },
    onUpdateError: function (f) { listeners['update-error'].push(f); },
    engineCheck: function () { ctl('/_desktop/engine/check'); },
    engineDownload: function () { ctl('/_desktop/engine/download'); },
    engineCancel: function () { ctl('/_desktop/engine/cancel'); },
    engineInstall: function () { ctl('/_desktop/engine/install'); },
    engineRestart: function () { ctl('/_desktop/engine/restart'); },
    onEngineAvailable: function (f) { engineListeners['engine-available'].push(f); },
    onEngineNotAvailable: function (f) { engineListeners['engine-not-available'].push(f); },
    onEngineDownloadProgress: function (f) { engineListeners['engine-download-progress'].push(f); },
    onEngineDownloaded: function (f) { engineListeners['engine-downloaded'].push(f); },
    onEngineInstalling: function (f) { engineListeners['engine-installing'].push(f); },
    onEngineInstallProgress: function (f) { engineListeners['engine-install-progress'].push(f); },
    onEngineInstallReady: function (f) { engineListeners['engine-install-ready'].push(f); },
    onEngineInstalled: function (f) { engineListeners['engine-installed'].push(f); },
    onEngineError: function (f) { engineListeners['engine-error'].push(f); }
  };
})();
</script>`;
  return html.replace('</head>', `${shim}</head>`);
}

/**
 * Open (or focus) a dialog window with the given kind. The Rust shell builds
 * the window against a real http:// page (data: URLs are rejected by the
 * remote-origin ACL), so the HTML is cached here and served from the control
 * API; /show-window only carries geometry.
 */
export function showWindow(kind: string, html: string, width: number, height: number, dark: boolean): void {
  cachePage(kind, withDialogShim(kind, html));
  void postToShell('/show-window', { kind, width, height, dark });
}

const sseClients = new Set<ServerResponse>();

export function broadcastEvent(type: string, payload: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

export function createControlServer(opts: ControlServerOptions): Server {
  const server = createServer((req, res) => {
    void handle(req, res, opts);
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function authorize(req: IncomingMessage, opts: ControlServerOptions): boolean {
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${opts.token}`) return true;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return url.searchParams.get('token') === opts.token;
}

/** Push to the Rust shell's control service (mirror of updater.ts shellFetch). */
export async function postToShell(pathname: string, body: unknown): Promise<void> {
  const port = Number(process.env.DSHD_DESKTOP_CONTROL_PORT ?? 0);
  const token = process.env.DSHD_CONTROL_TOKEN ?? '';
  if (!port) return;
  try {
    await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best effort — the shell may be gone */
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...corsHeaders(),
  });
  res.end(text);
}

function text(res: ServerResponse, status: number, body: string, contentType = 'text/plain'): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 1 << 20) throw new Error('payload too large');
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ControlServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (!authorize(req, opts)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  try {
    if (path === '/_desktop/ping' && method === 'GET') {
      text(res, 200, 'pong');
      return;
    }

    if (path === '/_desktop/config' && method === 'GET') {
      const key = url.searchParams.get('key');
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      if (key) {
        json(res, 200, { key, value: cfg[key] });
      } else {
        json(res, 200, cfg);
      }
      return;
    }

    if (path === '/_desktop/config' && method === 'PUT') {
      const body = (await readJson(req)) as { key?: string; value?: unknown };
      if (typeof body.key !== 'string') {
        json(res, 400, { error: 'key required' });
        return;
      }
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      cfg[body.key] = body.value;
      saveConfig(cfg as unknown as DesktopConfig);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/_desktop/language' && method === 'PUT') {
      const body = (await readJson(req)) as { lang?: string };
      const lang = body?.lang;
      if (lang !== 'en' && lang !== 'zh-CN') {
        json(res, 400, { error: 'lang must be en or zh-CN' });
        return;
      }
      const cfg = loadConfig();
      cfg.language = lang;
      saveConfig(cfg);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/_desktop/user-data-path' && method === 'GET') {
      json(res, 200, { path: process.env.DSHD_HOME ?? '' });
      return;
    }

    if (path === '/_desktop/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(),
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (path.startsWith('/_desktop/updater/')) {
      await handleUpdater(path, method, req, res);
      return;
    }

    if (path.startsWith('/_desktop/engine/')) {
      await handleEngine(path, method, req, res);
      return;
    }

    if (path.startsWith('/_desktop/plugin/')) {
      await handlePlugin(path, method, url, req, res);
      return;
    }

    // Plugin-manager window loads this URL (see windows.rs show_plugins_window).
    if (path === '/_desktop/pages/plugin-manager' && method === 'GET') {
      const pluginPage = await import('./plugin-manager.js');
      const html = pluginPage.getPluginPageHtml();
      if (!html) {
        text(res, 404, 'plugin manager page not found');
        return;
      }
      text(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (path === '/_desktop/dialog/close' && method === 'POST') {
      const body = (await readJson(req)) as { kind?: string };
      const kind = typeof body?.kind === 'string' ? body.kind : '';
      // Forward to the Rust shell's control service, which owns the window.
      await postToShell('/close-window', { kind });
      json(res, 200, { ok: true });
      return;
    }

    // Updater dialog windows load this URL (see windows.rs show_dialog_window).
    if (path.startsWith('/_desktop/pages/updater/') && method === 'GET') {
      const kind = path.slice('/_desktop/pages/updater/'.length);
      const html = updaterPages.get(kind);
      if (!html) {
        text(res, 404, 'page not cached');
        return;
      }
      text(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (path === '/_desktop/dsh-auth' && method === 'GET') {
      try {
        const { getDshAuth } = await import('./dsh-auth.js');
        json(res, 200, getDshAuth() ?? {});
      } catch {
        json(res, 200, {});
      }
      return;
    }

    if (path === '/_desktop/shutdown' && method === 'POST') {
      // Graceful stop: bootstrap().stop() closes channels/cron/WS/HTTP/db.
      // If stop() hangs (server.close() waiting on a lingering connection),
      // force-exit after a deadline so the ports are released and a respawn
      // can bind — previously the process stayed alive holding the control
      // port, and the next spawn died with EADDRINUSE.
      text(res, 200, 'shutting down');
      const forceExit = setTimeout(() => {
        console.error('[sidecar] stop() timed out — forcing exit');
        process.exit(0);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref?.();
      setTimeout(() => {
        void opts
          .stop()
          .catch((e) => console.error('[sidecar] stop() failed:', e))
          .finally(() => {
            clearTimeout(forceExit);
            process.exit(0);
          });
      }, 100);
      return;
    }

    json(res, 404, { error: `not found: ${method} ${path}` });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

// -- updater routes (M3): wired when updater.ts is ported --------------------

async function handleUpdater(
  path: string,
  _method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action = path.slice('/_desktop/updater/'.length);
  try {
    const updater = await import('./updater.js');
    switch (action) {
      case 'check': {
        const body = (await readJson(req)) as { includeBeta?: boolean; fromTray?: boolean };
        if (body?.fromTray) {
          // Tray flow: spinner window + result dialogs.
          void updater.getAppUpdater().checkForUpdatesFromTray();
        } else {
        // WebUI flow: SSE events back to the UI.
          void updater.getAppUpdater().checkForUpdates(body?.includeBeta ?? false);
        }
        json(res, 200, { ok: true });
        return;
      }
      case 'download': {
        void updater.getAppUpdater().downloadUpdate();
        json(res, 200, { ok: true });
        return;
      }
      case 'cancel': {
        updater.getAppUpdater().cancelDownload();
        json(res, 200, { ok: true });
        return;
      }
      case 'install': {
        void updater.getAppUpdater().installUpdate();
        json(res, 200, { ok: true });
        return;
      }
      default:
        json(res, 404, { error: `unknown updater action: ${action}` });
    }
  } catch (e) {
    json(res, 501, { error: `updater not available: ${e instanceof Error ? e.message : e}` });
  }
}

// -- engine routes: DeepSeek Harness engine (upstream dsh) update channel ---

async function handleEngine(
  path: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action = path.slice('/_desktop/engine/'.length);
  try {
    const updater = await import('./engine-updater.js');
    if (action === 'status' && method === 'GET') {
      json(res, 200, updater.getEngineUpdater().status());
      return;
    }
    if (action === 'check' && method === 'POST') {
      // About-page button: no popup — the page renders the inline flow from
      // /engine/status (the startup silent check passes popup:true itself).
      void updater.getEngineUpdater().checkForUpdate({ popup: false });
      json(res, 200, { ok: true });
      return;
    }
    if (action === 'download' && method === 'POST') {
      void updater.getEngineUpdater().downloadUpdate();
      json(res, 200, { ok: true });
      return;
    }
    if (action === 'install' && method === 'POST') {
      void updater.getEngineUpdater().installUpdate();
      json(res, 200, { ok: true });
      return;
    }
    if (action === 'download-install' && method === 'POST') {
      // Combined About-page action: download, then swap + restart right away
      // (no intermediate user-confirmed restart step).
      void updater.getEngineUpdater().downloadAndInstall();
      json(res, 200, { ok: true });
      return;
    }
    if (action === 'restart' && method === 'POST') {
      // User-confirmed restart applying a staged update — swaps the engine
      // closure, respawns dsh and health-checks it (with rollback).
      void updater.getEngineUpdater().restartUpdate();
      json(res, 200, { ok: true });
      return;
    }
    if (action === 'cancel' && method === 'POST') {
      updater.getEngineUpdater().cancelDownload();
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: `unknown engine action: ${action}` });
  } catch (e) {
    json(res, 501, { error: `engine updater not available: ${e instanceof Error ? e.message : e}` });
  }
}

// -- plugin routes (M6): `dsh plugin --profile web` wrapped for the UI ------

async function handlePlugin(
  path: string,
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const action = path.slice('/_desktop/plugin/'.length);
  try {
    const plugins = await import('./plugin-manager.js');
    const manager = plugins.getPluginManager();

    if (action === 'list' && method === 'GET') {
      json(res, 200, manager.list());
      return;
    }

    if (action === 'outdated' && method === 'GET') {
      // ?refresh=1 re-fetches instead of serving the TTL cache — the UI calls
      // it right before an update action ("check versions first").
      const force = url.searchParams.get('refresh') === '1';
      json(res, 200, { plugins: await plugins.checkOutdated(force) });
      return;
    }

    if (action === 'restart' && method === 'POST') {
      // UI "restart now" button — ask the shell to respawn the service.
      await postToShell('/restart-service', {});
      json(res, 200, { ok: true });
      return;
    }

    if (action === 'install' && method === 'POST') {
      const body = (await readJson(req)) as { spec?: unknown; restart?: unknown };
      const err = plugins.validateSpec(body?.spec);
      if (err) {
        json(res, 400, { error: err });
        return;
      }
      const started = manager.start('install', body.spec as string, body?.restart === true);
      if ('error' in started) {
        json(res, 409, { error: started.error });
        return;
      }
      json(res, 202, { jobId: started.jobId });
      return;
    }

    if (action === 'remove' && method === 'POST') {
      const body = (await readJson(req)) as { name?: unknown; restart?: unknown };
      const err = plugins.validateName(body?.name);
      if (err) {
        json(res, 400, { error: err });
        return;
      }
      const started = manager.start('remove', body.name as string, body?.restart === true);
      if ('error' in started) {
        json(res, 409, { error: started.error });
        return;
      }
      json(res, 202, { jobId: started.jobId });
      return;
    }

    if (action === 'update' && method === 'POST') {
      const body = (await readJson(req)) as { name?: unknown; restart?: unknown };
      if (body?.name !== undefined && body?.name !== null && body.name !== '') {
        const err = plugins.validateName(body.name);
        if (err) {
          json(res, 400, { error: err });
          return;
        }
      }
      const started = manager.start(
        'update',
        typeof body?.name === 'string' ? body.name : undefined,
        body?.restart === true,
      );
      if ('error' in started) {
        json(res, 409, { error: started.error });
        return;
      }
      json(res, 202, { jobId: started.jobId });
      return;
    }

    if (action.startsWith('status/') && method === 'GET') {
      const id = action.slice('status/'.length);
      const job = manager.getJob(id);
      if (!job) {
        json(res, 404, { error: 'job not found' });
        return;
      }
      json(res, 200, { job });
      return;
    }

    if (action.startsWith('cancel/') && method === 'POST') {
      const id = action.slice('cancel/'.length);
      const canceled = manager.cancel(id);
      json(res, canceled ? 200 : 404, canceled ? { ok: true } : { error: 'job not found or not running' });
      return;
    }

    json(res, 404, { error: `unknown plugin action: ${action}` });
  } catch (e) {
    json(res, 501, { error: `plugin manager not available: ${e instanceof Error ? e.message : e}` });
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — anti-orphan: the shell's control service must stay reachable or
// the sidecar exits itself (Rust dying cannot leave the server running).
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 3000;
const MISSED_HEARTBEAT_LIMIT = 3;

let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * @param onShellLost Invoked once the heartbeat limit is reached. The caller
 *   must tear down the dsh child (graceful SIGTERM → SIGKILL) BEFORE exiting —
 *   dsh is a separate process, so a bare `process.exit()` here would orphan it
 *   and leave port 3080 occupied (OhMyAgent could exit in place because its
 *   gateway ran in-process).
 */
export function startHeartbeat(
  ctlPort: number,
  token: string,
  controlPort?: number,
  onShellLost?: () => void,
): void {
  const url = `http://127.0.0.1:${ctlPort}/ping`;
  let missed = 0;

  const tick = async (): Promise<void> => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        // Report the actually-bound control API port so the shell can keep
        // tray requests pointed at the live one.
        body: JSON.stringify({ controlPort }),
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        missed = 0;
      } else {
        missed += 1;
      }
    } catch {
      missed += 1;
    }
    if (missed >= MISSED_HEARTBEAT_LIMIT) {
      console.error(`[sidecar] heartbeat failed ${missed} times — shell unreachable, exiting`);
      if (onShellLost) {
        onShellLost();
      } else {
        process.exit(0);
      }
    }
  };

  void tick();
  heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

/** Data dir setup shared with index.ts */
export function ensureDataDirs(): string {
  // The shell always passes DSHD_HOME (the upstream dsh home `~/.dsh`);
  // the fallback must never resolve into the cwd (which on Windows is the
  // sidecar root inside the install dir — uninstall would orphan/delete
  // user data with the app). Fall back to the upstream default home.
  const home = process.env.DSHD_HOME ?? join(homedir(), '.dsh');
  mkdirSync(join(home, 'data'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  process.env.DSHD_LOG_DIR ??= join(home, 'logs');
  return home;
}
