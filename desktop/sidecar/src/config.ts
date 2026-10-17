// Desktop config — port of desktop/src/config.ts (electron-store) to a plain
// JSON file at <data_dir>/desktop-config.json. Same path and file name as
// electron-store used, but the file now lives under the upstream dsh home
// (~/.dsh) like all other user data.
// The sidecar is the primary writer; the Rust shell mirrors it by polling
// mtime (see src-tauri/src/config.rs).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DesktopConfig {
  closeToTray: boolean;
  autoStart: boolean;
  theme: 'system' | 'light' | 'dark';
  /** UI language ('en' or 'zh-CN'), persisted across restarts. */
  language?: 'en' | 'zh-CN';
  /** Which adapter family the web server binds (engine 0.2.1-alpha.5+
   *  single-bind model). 'lan' = physical LAN adapter, 'tailscale' = tailnet
   *  CGNAT address so tailnet devices connect directly. Choosing the wrong
   *  family for the user's workflow restricts direct access to adapters of
   *  the other family (a proxy hop like `tailscale serve` still works);
   *  editable from the Web-Access panel, applied by respawning dsh. */
  bindAdapter?: 'lan' | 'tailscale';
  firstRunDone: boolean;
}

// electron-store schema defaults (orphan keys like window/minimizeToTray/
// serverPort are intentionally dropped — nothing read them at runtime).
const DEFAULTS: DesktopConfig = {
  closeToTray: true,
  autoStart: false,
  theme: 'system',
  bindAdapter: 'lan',
  firstRunDone: false,
};

function configPath(): string {
  const home = process.env.DSHD_HOME ?? '.';
  return join(home, 'desktop-config.json');
}

export function loadConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<DesktopConfig>;
    // Sanitize unknown bindAdapter values the file may carry from future
    // versions — lan-bind treats anything but 'tailscale' as 'lan'.
    const bindAdapter = raw.bindAdapter === 'tailscale' ? 'tailscale' : 'lan';
    return {
      ...DEFAULTS,
      ...raw,
      bindAdapter: bindAdapter as 'lan' | 'tailscale',
    };
  } catch {
    // Missing or corrupt — start from defaults.
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg: DesktopConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmp, p); // atomic — the shell's mtime poll never sees a partial file
}
