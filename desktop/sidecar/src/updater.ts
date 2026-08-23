// Updater — port of desktop/src/updater.ts (self-hosted GitHub Releases check,
// .part resumable download, SHA512 verify, installer spawn) without Electron.
//
// Electron dependencies replaced:
//   1. net.fetch            → global fetch (Node 22 stream API identical)
//   2. app.getVersion()     → process.env.DSHD_APP_VERSION
//   3. DSHD_HOME (the upstream dsh home ~/.dsh, passed by the shell)
//   4. webContents.send()   → broadcastEvent() (SSE to dialogs)
//   5. spawn(installer --updated) → POST shell /update-install (Rust spawns
//      the installer DETACHED and exits)
//   6. BrowserWindow dialogs → POST shell /show-window

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { marked } from 'marked';

import { broadcastEvent, cachePage, showWindow, withDialogShim } from './control-server.js';
import { downloadResumable, DownloadCancelledError } from './download.js';
import { loadConfig } from './config.js';
import { getT, interpolate } from './i18n.js';
import { fetchWithProxy } from './net.js';

// ---------------------------------------------------------------------------
// Version compare + latest.yml parser (verbatim from desktop/src/updater.ts)
// ---------------------------------------------------------------------------

function stripLeadingV(v: string): string {
  return v.replace(/^[vV]/, '');
}

/** Compare two version strings. Returns negative if a < b, 0 equal, positive if a > b.
 *  Follows semver precedence: ANY prerelease (beta/rc/alpha — the part after
 *  `-`) ranks below stable, so 2.0.0 > 2.0.0-rc1 > 2.0.0-beta3 >
 *  2.0.0-beta2 > 2.0.0-beta. Previously only "beta" was recognized — rc tags
 *  compared equal to their stable counterpart, so an rc user was never told
 *  about the stable release of the same version. */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  const paPre = pa.pre.length > 0;
  const pbPre = pb.pre.length > 0;
  if (!paPre && pbPre) return 1; // stable > prerelease
  if (paPre && !pbPre) return -1; // prerelease < stable
  if (paPre && pbPre) return comparePre(pa.pre, pb.pre);
  return 0;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers, e.g. ['beta', '2'] for 2.0.0-beta.2; [] = stable. */
  pre: string[];
}

function parseSemver(v: string): ParsedSemver {
  const cleaned = stripLeadingV(v);
  const [core, ...rest] = cleaned.split('-');
  const parts = core.split('.');
  const major = parseInt(parts[0] || '0', 10);
  const minor = parseInt(parts[1] || '0', 10);
  const patch = parseInt(parts[2] || '0', 10);
  const pre = rest.join('-').split('.').filter(Boolean);
  return { major, minor, patch, pre };
}

/** Compare prerelease identifier lists (semver §11.4.3): dot-separated,
 *  numeric identifiers below alphanumeric ones, compared left to right,
 *  shorter list ranks lower. */
function comparePre(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i >= a.length) return -1; // shorter list is lower
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return parseInt(x, 10) - parseInt(y, 10);
    if (xn) return -1; // numeric identifiers sort below alphanumeric
    if (yn) return 1;
    return x < y ? -1 : 1; // lexicographic: alpha < beta < rc
  }
  return 0;
}

/** Minimal YAML parser for latest.yml format (flat key: value + array of objects). */
export function parseLatestYml(  text: string,
): {
  version: string;
  files: Array<{ url: string; sha512: string }>;
  path: string;
  sha512: string;
  releaseDate: string;
} {
  const result: Record<string, unknown> & { files: Array<{ url: string; sha512: string }> } = {
    files: [],
  };
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.startsWith('#')) {
      i++;
      continue;
    }

    const kv = /^(\w[\w-]*\w?):\s*(.*)/.exec(line);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      if (key === 'files') {
        i++;
        while (i < lines.length && /^\s*-/.test(lines[i])) {
          // url may be quoted ("DeepSeek-Harness-Desktop-Setup-0.1.0.exe") or a bare
          // single token (a.exe). Capture the quoted form in full.
          const urlMatch =
            /url:\s*"([^"]*)"|url:\s*'([^']*)'|url:\s*(\S+)/.exec(lines[i]);
          let sha = '';
          const shaSameLine = /sha512:\s*(\S+)/.exec(lines[i]);
          if (shaSameLine) {
            sha = shaSameLine[1];
          } else {
            i++;
            if (i < lines.length) {
              const shaNext = /sha512:\s*(\S+)/.exec(lines[i]);
              if (shaNext) sha = shaNext[1];
            }
          }
          if (urlMatch) {
            const url = urlMatch[1] ?? urlMatch[2] ?? urlMatch[3];
            result.files.push({ url, sha512: sha });
          }
          i++;
        }
        continue;
      } else if (value !== '') {
        result[key] = value;
      }
    }
    i++;
  }
  return result as ReturnType<typeof parseLatestYml>;
}

interface CachedUpdate {
  version: string;
  releaseNotes: string | null;
  releaseUrl: string;
  files: Array<{ url: string; sha512: string }>;
}

/**
 * Pick the update file for the running architecture.
 *
 * latest-mac.yml carries one entry per macOS architecture (x64 zip + arm64
 * zip, merged by the mac-meta CI job); Windows/Linux yml files have a single
 * entry, which is returned as-is. Selection rule:
 *   - exactly one file            -> it (single-arch platforms)
 *   - arm64 host                  -> the file whose name contains "arm64"
 *   - anything else (x64/universal)-> the file whose name does NOT contain
 *                                     "arm64"
 * Falls back to the first entry when nothing matches, so an unexpected yml
 * layout degrades to the old behavior instead of failing the update.
 */
export function selectUpdateFile(
  files: Array<{ url: string; sha512: string }>,
  arch: string = process.arch,
): { url: string; sha512: string } {
  if (files.length <= 1) {
    return files[0];
  }
  const wantsArm64 = arch === 'arm64';
  const match = files.find((f) => /arm64/.test(f.url) === wantsArm64);
  return match ?? files[0];
}

// ---------------------------------------------------------------------------
// Shell control API helpers (POST /show-window etc.)
// ---------------------------------------------------------------------------

function shellControlPort(): number {
  return Number(process.env.DSHD_DESKTOP_CONTROL_PORT ?? 0);
}

function shellControlToken(): string {
  return process.env.DSHD_CONTROL_TOKEN ?? '';
}

async function shellFetch(pathname: string, body?: unknown): Promise<void> {
  const port = shellControlPort();
  if (!port) {
    // Dev mode: no Rust shell control service — dialogs are skipped.
    diagLog(`shellFetch(${pathname}) skipped (no shell control port)`);
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${shellControlToken()}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : '{}',
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    diagLog(`shellFetch(${pathname}) failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Write an updater diagnostic message to the shared diag log. */
function diagLog(msg: string): void {
  try {
    const home = process.env.DSHD_HOME ?? '.';
    const logsDir = path.join(home, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(logsDir, 'dshd-diag.log'), `[${ts}] [AppUpdater] ${msg}\n`);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// AppUpdater
// ---------------------------------------------------------------------------

export class AppUpdater {
  private updateDownloaded = false;
  /** True while a download is in progress (used to classify errors). */
  private downloading = false;
  /** True when the user has cancelled an in-progress download. */
  private downloadCancelled = false;
  /** Cached result of macOS code-signature check. null = not yet checked. */
  private _macOSUnsigned: boolean | null = null;
  /** Cached update info from the last successful check. */
  private pendingUpdate: CachedUpdate | null = null;
  /**
   * Tray flow flag: the tray update dialog closes the moment "upgrade" is
   * clicked, so downloadUpdate() must open the progress window itself.
   * The WebUI flow has its own progress UI and must not get the window.
   */
  private _fromTrayFlow = false;

  /** Check for updates (called from WebUI via control API). Sends SSE events. */
  async checkForUpdates(includeBeta = false): Promise<void> {
    this.downloadCancelled = false;
    this.pendingUpdate = null;
    diagLog(`checkForUpdates() called includeBeta=${includeBeta}`);
    await this.runNetworkDiagnostic();

    try {
      const result = await this.checkForUpdateResult(includeBeta);

      if (!result) {
        diagLog('checkForUpdates: no update available');
        broadcastEvent('update-not-available', {});
        return;
      }

      const { release, latestVersion, updateInfo } = result;

      this.pendingUpdate = {
        version: latestVersion,
        releaseNotes: release.body || null,
        releaseUrl: release.html_url || '',
        files: updateInfo.files?.map((f) => ({ url: f.url, sha512: f.sha512 })) || [],
      };

      broadcastEvent('update-available', {
        version: latestVersion,
        releaseDate: release.published_at,
        releaseNotes: release.body,
      });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        diagLog('checkForUpdates: request timed out');
        broadcastEvent('update-error', {
          message: getT().updater.networkTimeout,
          raw: 'Request timed out',
        });
      } else {
        // Non-timeout failures must also reach the WebUI — without the
        // event the about page stays on "checking" forever.
        const rawMsg = e.message || String(err);
        diagLog(`checkForUpdates: error caught — ${rawMsg}`);
        console.error('[AppUpdater] Check for updates failed');
        broadcastEvent('update-error', {
          // Rate-limit 403s carry their own short i18n message; everything
          // else keeps the generic "check failed" label with details in raw.
          message: rawMsg.startsWith(getT().updater.rateLimitExceeded)
            ? rawMsg
            : getT().updater.checkFailed,
          raw: rawMsg,
        });
      }
    }
  }

  private async checkForUpdateResult(includeBeta: boolean): Promise<{
    release: {
      tag_name?: string;
      body?: string | null;
      html_url?: string;
      published_at?: string;
    };
    latestVersion: string;
    updateInfo: ReturnType<typeof parseLatestYml>;
  } | null> {
    const currentVersion = process.env.DSHD_APP_VERSION ?? '0.0.0';

    // Fetch releases from GitHub REST API.
    const apiUrl = 'https://api.github.com/repos/tscodeplus/dsh-desktop/releases?per_page=30';
    const resp = await fetchWithProxy(apiUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      // Surface GitHub's own reason — a 403 is usually a rate-limit rejection
      // ("API rate limit exceeded for <ip>", common on shared proxy egress)
      // or a User-Agent rejection. A rate-limit 403 dumps a long JSON body
      // that overflows the small dialog window, so those get a short i18n
      // message; other failures keep a truncated body snippet.
      const body = await resp.text().catch(() => '');
      const remaining = resp.headers.get('x-ratelimit-remaining');
      const status = resp.status;
      const detail =
        remaining !== null ? ` rate-limit remaining: ${remaining}` : '';
      if ((status === 403 || status === 429) && remaining === '0') {
        throw new Error(
          `${getT().updater.rateLimitExceeded} (${status}${detail})`,
        );
      }
      const snippet = body ? ` — ${body.trim().slice(0, 80)}` : '';
      throw new Error(`GitHub API returned ${status}${detail}${snippet}`);
    }

    const releases = (await resp.json()) as Array<{
      tag_name?: string;
      body?: string | null;
      html_url?: string;
      published_at?: string;
      prerelease?: boolean;
    }>;
    if (!Array.isArray(releases) || releases.length === 0) {
      return null;
    }

    // Sort by version, not list order: GitHub orders by creation time and
    // re-published legacy releases (e.g. the duplicate v0.2.0 entries) can
    // sit above newer versions, which would make the "latest" check pick
    // an old release (or report a downgrade as "up to date").
    const tagged = releases
      .filter((r) => r.tag_name && /^v?\d+(\.\d+)+/.test(r.tag_name))
      .map((r) => ({ ...r, version: r.tag_name!.replace(/^v/, '') }));
    tagged.sort((a, b) => compareVersions(b.version, a.version));
    const release = includeBeta
      ? tagged[0]
      : tagged.find((r) => !/beta/i.test(r.version));
    if (!release) {
      return null;
    }

    const latestVersion = (release.tag_name || '').replace(/^v/, '');
    diagLog(`checkForUpdateResult: remote=${latestVersion} current=${currentVersion}`);

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      return null;
    }

    // Fetch the platform metadata file (electron-builder convention) so
    // every platform keeps its own file URL list and the CI uploads never
    // clobber each other: latest.yml = Windows, latest-mac.yml = macOS,
    // latest-linux.yml = Linux.
    const ymlName =
      process.platform === 'win32'
        ? 'latest.yml'
        : process.platform === 'darwin'
          ? 'latest-mac.yml'
          : 'latest-linux.yml';
    const latestYmlUrl = `https://github.com/tscodeplus/dsh-desktop/releases/download/${release.tag_name}/${ymlName}`;
    diagLog(`checkForUpdateResult: fetching ${latestYmlUrl}`);
    const ymlResp = await fetchWithProxy(latestYmlUrl, { signal: AbortSignal.timeout(10_000) });
    if (!ymlResp.ok) {
      throw new Error(`${ymlName} returned ${ymlResp.status}`);
    }

    const ymlText = await ymlResp.text();
    const updateInfo = parseLatestYml(ymlText);
    diagLog(
      `checkForUpdateResult: parsed version=${updateInfo.version} files=${JSON.stringify(updateInfo.files?.map((f) => f.url))}`,
    );

    return { release, latestVersion, updateInfo };
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCancelled = false;
    diagLog('downloadUpdate() called');
    this.downloading = true;
    // Tray flow: the dialog window closes right after this call, so open the
    // download-progress window here (it listens to the SSE events and offers
    // the install button). The WebUI flow has its own progress UI.
    if (this._fromTrayFlow) {
      this._fromTrayFlow = false;
      this.showDownloadProgressWindow();
    }

    try {
      if (this.pendingUpdate) {
        await this.downloadFromPendingUpdate();
      } else {
        throw new Error('No pending update — run checkForUpdates first');
      }
      diagLog('downloadUpdate: completed successfully');
    } catch (err: unknown) {
      // User-initiated cancel keeps the .part for resume — not an error.
      if (err instanceof DownloadCancelledError) {
        diagLog('downloadUpdate: cancelled by user');
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      diagLog(`downloadUpdate: error caught — ${msg}`);
      console.error('[AppUpdater] Download failed');
      broadcastEvent('update-error', { message: msg, raw: msg });
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Download the installer via fetch with streaming-to-disk, resume support and
   * progress reporting. Same strategy as the Electron version: stream to a
   * `.part` file, resume with Range when the version marker matches, verify
   * SHA512, atomically rename.
   */
  private async downloadFromPendingUpdate(): Promise<void> {
    const update = this.pendingUpdate!;
    // multi-arch yml (macOS) carries one entry per architecture — pick ours.
    const fileInfo = selectUpdateFile(update.files);
    if (!fileInfo) {
      throw new Error('No files in update info');
    }
    const downloadUrl = `https://github.com/tscodeplus/dsh-desktop/releases/download/v${update.version}/${fileInfo.url}`;
    const downloadsDir = path.join(process.env.DSHD_HOME ?? '.', 'downloads');

    // Shared resumable download (see download.ts) — same semantics as the
    // original inline implementation: .part + .part.meta version marker,
    // Range resume, SHA512 verify, atomic rename.
    await downloadResumable({
      url: downloadUrl,
      destDir: downloadsDir,
      fileName: fileInfo.url,
      versionMarker: update.version,
      sha512: fileInfo.sha512,
      shouldCancel: () => this.downloadCancelled,
      onProgress: (p) => this.sendProgress(p.percent, p.bytesPerSecond, p.total, p.transferred),
      log: (m) => diagLog(`downloadFromPendingUpdate: ${m}`),
    });

    this.updateDownloaded = true;
    const unsigned = this.isMacOSUnsigned();
    this.sendDownloaded(update.version, update.releaseNotes, unsigned);
  }

  private sendProgress(percent: number, bytesPerSecond: number, total: number, transferred: number): void {
    broadcastEvent('update-download-progress', { percent, bytesPerSecond, total, transferred });
  }

  private sendDownloaded(version: string, releaseNotes: string | null, unsigned: boolean): void {
    broadcastEvent('update-downloaded', { version, releaseNotes, unsigned });
  }

  /**
   * Check whether the current macOS build lacks a valid Apple code signature.
   * Unsigned builds can download updates but cannot auto-install.
   */
  isMacOSUnsigned(): boolean {
    if (this._macOSUnsigned !== null) return this._macOSUnsigned;
    if (process.platform !== 'darwin') {
      this._macOSUnsigned = false;
      return false;
    }
    try {
      execFileSync('codesign', ['-dv', process.execPath], {
        stdio: 'ignore',
        timeout: 5_000,
      });
      this._macOSUnsigned = false;
    } catch {
      this._macOSUnsigned = true;
    }
    diagLog(`macOS code-signature check: unsigned=${this._macOSUnsigned}`);
    return this._macOSUnsigned;
  }

  /** Install the downloaded update: ask the shell to spawn the installer and exit. */
  async installUpdate(): Promise<void> {
    if (!this.updateDownloaded) {
      diagLog('installUpdate: updateDownloaded is false — no-op');
      return;
    }
    if (this.isMacOSUnsigned()) {
      diagLog('installUpdate: unsigned macOS build — opening GitHub Releases');
      void shellFetch('/open-external', { url: 'https://github.com/tscodeplus/dsh-desktop/releases' });
      return;
    }

    if (this.pendingUpdate && process.platform === 'win32') {
      const downloadsDir = path.join(process.env.DSHD_HOME ?? '.', 'downloads');
      const installerName = selectUpdateFile(this.pendingUpdate.files)?.url;
      const installerPath = path.join(downloadsDir, installerName);
      if (installerName && fs.existsSync(installerPath)) {
        diagLog(`installUpdate: shell spawns ${installerPath} --updated`);
        // Rust spawns the installer DETACHED and exits the shell.
        await shellFetch('/update-install', { path: installerPath });
        return;
      }
      diagLog(`installUpdate: installer not found at ${installerPath}`);
    }

    diagLog('installUpdate: no compatible install path (mac non-unsigned not yet supported)');
    // macOS signed builds: future tauri-plugin-updater / manual flow.
    void shellFetch('/open-external', { url: 'https://github.com/tscodeplus/dsh-desktop/releases' });
  }

  cancelDownload(): void {
    diagLog('cancelDownload() called');
    this.downloadCancelled = true;
    this.downloading = false;
  }

  isUpdateDownloaded(): boolean {
    return this.updateDownloaded;
  }

  /**
   * Check for updates from the tray — spinner window during the check, then a
   * dialog with the result. All windows are rendered by the Rust shell via
   * POST /show-window.
   */
  async checkForUpdatesFromTray(): Promise<void> {
    // The tray dialog closes right after downloadUpdate() is clicked, so the
    // progress window must be opened from within downloadUpdate() itself.
    this._fromTrayFlow = true;
    const isDark = this.isDarkTheme();

    const primaryBg = isDark ? '#1e1e2e' : '#f8fafc';
    const textColor = isDark ? '#cdd6f4' : '#334155';
    const textMuted = isDark ? '#a6adc8' : '#64748b';
    const spinnerTrack = isDark ? 'rgba(205,214,244,0.15)' : 'rgba(51,65,85,0.12)';
    const spinnerFill = isDark ? '#89b4fa' : '#6366f1';

    const spinnerHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
       height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${primaryBg};color:${textColor};user-select:none}
  .spinner{width:36px;height:36px;border:3px solid ${spinnerTrack};
           border-top-color:${spinnerFill};border-radius:50%;
           animation:spin .7s linear infinite;margin-bottom:18px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .label{font-size:13px;color:${textMuted}}
</style></head>
<body>
  <div class="spinner"></div>
  <div class="label">${getT().updater.checking}</div>
</body></html>`;

    showWindow('spinner', spinnerHtml, 320, 180, isDark);

    try {
      const result = await this.checkForUpdateResult(true);

      if (result) {
        const currentVer = process.env.DSHD_APP_VERSION ?? '0.0.0';
        if (result.latestVersion === currentVer) {
          this.showUpToDateDialog();
        } else {
          this.pendingUpdate = {
            version: result.latestVersion,
            releaseNotes: result.release.body || null,
            releaseUrl: result.release.html_url || '',
            files: result.updateInfo.files?.map((f) => ({ url: f.url, sha512: f.sha512 })) || [],
          };
          this.showUpdateDialogForTray({
            version: result.latestVersion,
            releaseNotes: result.release.body,
          });
        }
      } else {
        this.showUpToDateDialog();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Generic i18n "check failed" title — the rate-limit 403's full short
      // message ("GitHub API 限流，请稍后重试 (403 rate-limit remaining: 0)")
      // goes in the body only, same shape as the WebUI about page dialog.
      this.showMessageDialog(getT().updater.checkFailed, msg);
    }
  }

  /** "Already up to date" dialog window. */
  private showUpToDateDialog(): void {
    const isDark = this.isDarkTheme();
    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const btnPrimary = '#6366f1';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh}
  .icon{margin-bottom:16px}
  .icon svg{width:40px;height:40px;color:#22c55e}
  .message{font-size:15px;font-weight:600;color:${fg};text-align:center;margin-bottom:24px}
  .footer{position:absolute;bottom:0;left:0;right:0;padding:14px 20px;
          display:flex;justify-content:flex-end;
          border-top:1px solid ${border}}
  button{padding:7px 18px;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;transition:opacity .15s;outline:none}
  .btn-primary{background:${btnPrimary};color:#fff}
</style></head>
<body>
  <div class="icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  </div>
  <div class="message">${getT().updater.upToDate}</div>
  <div class="footer">
    <button class="btn-primary" onclick="window.__dshDialog.close()">${getT().updater.ok}</button>
  </div>
</body></html>`;

    showWindow('up-to-date', html, 320, 220, isDark);
  }

  /** Error dialog window. */
  private showMessageDialog(title: string, detail: string): void {
    const isDark = this.isDarkTheme();
    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};padding:24px;display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh;text-align:center}
  h3{margin:0 0 10px;font-size:15px;color:#ef4444}
  p{font-size:13px;color:${fg};opacity:.8;margin:0 0 20px;line-height:1.6;
    word-break:break-all;overflow-wrap:anywhere;overflow-y:auto;max-height:110px}
  p::-webkit-scrollbar{width:5px}
  p::-webkit-scrollbar-track{background:transparent}
  p::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.35);border-radius:3px}
  button{padding:7px 22px;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;background:#6366f1;color:#fff}
</style></head>
<body>
  <h3>${title}</h3>
  <p>${detail.replace(/</g, '&lt;')}</p>
  <button onclick="window.__dshDialog.close()">${getT().updater.ok}</button>
</body></html>`;

    showWindow('updater-dialog', html, 380, 240, isDark);
  }

  /** Update-available dialog with release notes. */
  private showUpdateDialogForTray(info: { version: string; releaseNotes?: string | null }): void {
    const version = info.version;
    const notesHtml = this.getReleaseNotesHtml(info.releaseNotes);
    const isDark = this.isDarkTheme();

    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const contentBg = isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc';
    const btnPrimary = '#6366f1';
    const btnSecondaryBg = isDark ? 'rgba(255,255,255,0.08)' : '#f1f5f9';
    const btnSecondaryFg = isDark ? '#cbd5e1' : '#475569';
    const btnSecondaryHover = isDark ? 'rgba(255,255,255,0.14)' : '#e2e8f0';
    const scrollThumb = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
    const scrollThumbHover = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';

    const notesBody =
      notesHtml || `<p style="color:${muted}">${getT().updater.noReleaseNotes}</p>`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;height:100vh}
  .header{flex-shrink:0;padding:20px 24px 12px}
  .header h1{font-size:17px;font-weight:700;color:${fg};margin:0}
  .content{flex:1;overflow-y:auto;padding:12px 24px 16px;
           font-size:13px;line-height:1.7;color:${fg};
           background:${contentBg};margin:0 12px;border-radius:8px;
           border:1px solid ${border}}
  .content h1,.content h4{font-size:14px;font-weight:600;margin:12px 0 6px;color:${fg}}
  .content h2{font-size:14px;font-weight:600;margin:12px 0 6px;color:${fg}}
  .content h3{font-size:13px;font-weight:600;margin:10px 0 4px;color:${fg}}
  .content ul,.content ol{padding-left:20px;margin:6px 0}
  .content li{margin:2px 0}
  .content p{margin:6px 0}
  .content a{color:#6366f1}
  .content code{background:${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'};
                padding:1px 5px;border-radius:4px;font-size:12px}
  .content pre{background:${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
               padding:10px 14px;border-radius:6px;overflow-x:auto;margin:8px 0;
               font-size:12px;line-height:1.5}
  .content blockquote{margin:6px 0;padding:2px 12px;border-left:3px solid ${border};color:${muted}}
  .content blockquote p{margin:4px 0}
  .content table{border-collapse:collapse;margin:8px 0;width:100%;font-size:12px}
  .content th,.content td{border:1px solid ${border};padding:4px 8px;text-align:left}
  .content th{background:${isDark ? 'rgba(255,255,255,0.05)' : '#f1f5f9'};font-weight:600}
  .content hr{border:none;border-top:1px solid ${border};margin:10px 0}
  .content img{max-width:100%;border-radius:6px}
  .content::-webkit-scrollbar{width:5px}
  .content::-webkit-scrollbar-track{background:transparent}
  .content::-webkit-scrollbar-thumb{background:${scrollThumb};border-radius:3px}
  .content::-webkit-scrollbar-thumb:hover{background:${scrollThumbHover}}
  .footer{flex-shrink:0;padding:16px 24px 20px;display:flex;
          justify-content:flex-end;gap:10px;
          border-top:1px solid ${border}}
  button{padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;transition:opacity .15s,background .15s;outline:none}
  .btn-primary{background:${btnPrimary};color:#fff}
  .btn-primary:hover{opacity:0.88}
  .btn-secondary{background:${btnSecondaryBg};color:${btnSecondaryFg}}
  .btn-secondary:hover{background:${btnSecondaryHover}}
</style></head>
<body>
  <div class="header">
    <h1>${interpolate(getT().updater.newVersion, { version })}</h1>
  </div>
  <div class="content">${notesBody}</div>
  <div class="footer">
    <button class="btn-secondary" onclick="window.__dshDialog.close()">${getT().updater.cancel}</button>
    <button class="btn-primary" onclick="window.__dshDialog.downloadUpdate();window.__dshDialog.close()">${getT().updater.upgrade}</button>
  </div>
</body></html>`;

    showWindow('updater-dialog', html, 500, 460, isDark);
  }

  /** Download progress window — listens to updater events (SSE). */
  private showDownloadProgressWindow(): void {
    const isDark = this.isDarkTheme();
    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const barBg = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const barFill = '#6366f1';
    const btnPrimary = '#6366f1';
    const btnSecondaryBg = isDark ? 'rgba(255,255,255,0.08)' : '#f1f5f9';
    const btnSecondaryFg = isDark ? '#cbd5e1' : '#475569';
    const unsignedMsg = getT().updater.unsignedMacBuild.replace(/'/g, "\\'");

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh;
       user-select:none}
  .header{position:absolute;top:0;left:0;right:0;padding:16px 24px 0;
          text-align:center;font-size:14px;font-weight:600}
  .card{display:flex;flex-direction:column;align-items:center;gap:14px;width:320px}
  .label{font-size:13px;color:${muted}}
  .bar-wrap{width:100%;height:6px;border-radius:3px;background:${barBg};overflow:hidden}
  .bar-fill{height:100%;border-radius:3px;background:${barFill};
            width:0%;transition:width .2s ease-out}
  .percent{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
  .speed{font-size:12px;color:${muted}}
  .status{font-size:13px;font-weight:600;text-align:center;line-height:1.4;
          max-width:320px;word-break:keep-all;overflow-wrap:break-word}
  .footer{position:absolute;bottom:0;left:0;right:0;padding:14px 20px;
          display:flex;justify-content:flex-end;gap:10px;
          border-top:1px solid ${border}}
  button{padding:7px 18px;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;transition:opacity .15s,background .15s;outline:none}
  .btn-primary{background:${btnPrimary};color:#fff}
  .btn-secondary{background:${btnSecondaryBg};color:${btnSecondaryFg}}
</style></head>
<body>
  <div class="header">${getT().updater.downloading}</div>
  <div class="card">
    <div class="percent" id="pct">0%</div>
    <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
    <div class="speed" id="spd">&nbsp;</div>
    <div class="status" id="st"></div>
  </div>
  <div class="footer">
    <button class="btn-secondary" id="btn-releases" style="display:none">${getT().updater.githubRelease}</button>
    <button class="btn-secondary" id="btn-close">${getT().updater.cancel}</button>
    <button class="btn-primary" id="btn-install" style="display:none">${getT().updater.installAndRestart}</button>
  </div>
<script>
  var api = window.__dshDialog;
  function fmtSize(b){if(!b||b<=0)return'';var u=['B','KB','MB','GB'];var i=0,v=b;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(v<10?1:0)+' '+u[i]}
  function fmtSpeed(bps){var s=fmtSize(bps);return s?s+'/s':''}
  var _lastPct=0;
  document.getElementById('btn-close').addEventListener('click',function(){api.cancelDownload();window.__dshDialog.close()});
  document.getElementById('btn-install').addEventListener('click',function(){api.installUpdate()});
  document.getElementById('btn-releases').addEventListener('click',function(){window.open('https://github.com/tscodeplus/dsh-desktop/releases')});
  api.onUpdateDownloadProgress(function(d){
    var pct=Math.round(d.percent);
    if(pct<_lastPct)return; _lastPct=pct;
    document.getElementById('pct').textContent=pct+'%';
    document.getElementById('bar').style.width=pct+'%';
    document.getElementById('spd').textContent=fmtSpeed(d.bytesPerSecond||0);
  });
  api.onUpdateDownloaded(function(d){
    document.getElementById('pct').textContent='100%';
    document.getElementById('bar').style.width='100%';
    document.getElementById('spd').textContent='';
    if(d&&d.unsigned){
      document.getElementById('st').textContent='${unsignedMsg}';
      document.getElementById('btn-releases').style.display='';
      document.getElementById('btn-install').style.display='none';
    }else{
      document.getElementById('st').textContent='${getT().updater.downloaded}';
      document.getElementById('btn-install').style.display='';
      document.getElementById('btn-releases').style.display='none';
    }
  });
  api.onUpdateError(function(d){
    document.getElementById('st').textContent=d.message||'${getT().updater.downloadFailed}';
    document.getElementById('btn-releases').style.display='';
  });
</script>
</body></html>`;

    showWindow('progress', html, 420, 260, isDark);
  }

  /** Theme helper: desktop config theme, falling back to OS dark preference. */
  private isDarkTheme(): boolean {
    try {
      const theme = loadConfig().theme;
      if (theme === 'dark') return true;
      if (theme === 'light') return false;
    } catch {
      /* config not ready */
    }
    // "system" theme (or config not ready): the Rust shell injects the OS
    // dark preference (DSHD_OS_DARK); in practice the theme-watch init
    // script also persists the WebUI's rendered theme to desktop-config.json
    // within moments of boot, so this path only matters very early.
    const osDark = process.env.DSHD_OS_DARK;
    if (osDark === '1') return true;
    if (osDark === '0') return false;
    return true;
  }

  /** Log proxy / connectivity diagnostics (fetch-based, no Electron session). */
  private async runNetworkDiagnostic(): Promise<void> {
    const testUrls = [
      { label: 'GitHub API', url: 'https://api.github.com/repos/tscodeplus/dsh-desktop/releases/latest' },
      { label: 'latest.yml (beta3)', url: 'https://github.com/tscodeplus/dsh-desktop/releases/download/v2.0.0-beta3/latest.yml' },
    ];
    for (const { label, url } of testUrls) {
      try {
        const resp = await fetchWithProxy(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(10_000),
        });
        diagLog(`[${label}] OK status=${resp.status} (${resp.headers.get('content-length') || '?'} bytes)`);
      } catch (e: unknown) {
        diagLog(`[${label}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Convert GitHub-flavored Markdown release notes to HTML (verbatim from
   * desktop/src/updater.ts).
   */
  private getReleaseNotesHtml(
    notes: string | Array<string | { note: string | null }> | null | undefined,
  ): string {
    if (!notes) return '';
    const text = Array.isArray(notes)
      ? notes.map((n) => (typeof n === 'string' ? n : (n.note ?? ''))).join('\n')
      : String(notes);
    return mdToHtml(text);
  }
}

// ---------------------------------------------------------------------------
// Release-notes markdown rendering (GFM via marked — see OhMyAgent's
// react-markdown + remark-gfm approach for the same requirement).
// ---------------------------------------------------------------------------

const RELEASE_NOTES_MAX = 3000;

/** Neutralize active tags, event handlers and javascript: URLs. Not a full
 * sanitizer (marked does not sanitize); the feed is our own GitHub Releases
 * body, so this is defense-in-depth, not a security boundary. */
function sanitizeReleaseHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/href\s*=\s*["']?javascript:[^"'\s>]*["']?/gi, 'href="#"')
    .replace(/src\s*=\s*["']?javascript:[^"'\s>]*["']?/gi, 'src=""');
}

/**
 * Render GitHub-Flavored Markdown release notes to safe HTML. The old
 * hand-rolled regex renderer left GFM constructs raw — blockquotes (`>`),
 * tables (`| … |`), task lists and strikethrough appeared as literal text.
 * marked renders those natively (gfm on by default); pure + exported for
 * tests. Pre-rendered HTML input passes through with the same sanitization.
 */
export function mdToHtml(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';

  let html: string;
  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    html = sanitizeReleaseHtml(trimmed);
  } else {
    html = sanitizeReleaseHtml(marked.parse(trimmed) as string);
  }
  return html.length > RELEASE_NOTES_MAX ? html.slice(0, RELEASE_NOTES_MAX) + '…' : html;
}

// Singleton
let instance: AppUpdater | null = null;

export function getAppUpdater(): AppUpdater {
  if (!instance) {
    instance = new AppUpdater();
  }
  return instance;
}
