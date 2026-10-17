// Pre-flight migration for the LAN/Tailscale bind config
// (`<home>/profiles/web/cordis.patch.yml`) against engine 0.2.1-alpha.5+.
//
// Upstream 0.2.1-alpha.5 hardened the web server's bind validation:
//
//  1. `webserver.host` rejects wildcard addresses ('0.0.0.0' / '::') at the
//     config schema level (previously only the CLI --host flag banned them —
//     deployments-layer config was the desktop's supported wildcard path).
//  2. The `webRuntime` service was removed from dsh-web-app (replaced by
//     `webStartup`, whose trustedHosts come from --trusted-host flags only).
//     A webserver bound to all interfaces used to auto-derive every local
//     LAN/Tailscale IPv4 into `webRuntime.trustedHosts` — that auto-deriving
//     composition no longer exists.
//  3. The bind IP itself is always accepted by the /api fence
//     (bind-address authority) for any request authority matching it.
//
// The desktop's remote-access design therefore must declare concrete values
// in the user patch layer, and the sidecar owns keeping them current:
// before every dsh spawn, select ONE concrete interface address (physical
// LAN first, Tailscale CGNAT second, loopback fallback) and rewrite
//
//   - id: webserver  → config.host = <bind IP>, config.port = 3080 (plain)
//   - id: connection → config.trustedHosts = [<bind IP>, <tailnet IPv4>,
//                       ...preserved non-IP entries (MagicDNS names)]
//
// replacing any stale `!!js` interpolation (engine-side tooling parses the
// layer with js-yaml v4 and cannot resolve the custom tag — a leftover
// `!!js` row makes the patch watcher log "unknown tag" every recompose).
//
// The Tauri shell loads the WebUI via the pushed launch URL (webui_url
// prefers dsh's own `?token=` URL, which carries the bind host), and the
// shell's health probe additionally probes that authority — so a LAN-only
// bind still serves the desktop UI. The migration is idempotent: a spawn
// with an unchanged network writes nothing.
//
// Non-fatal by design: any read/parse/write failure logs and leaves the file
// untouched; dsh still spawns (on a fresh install without a patch layer the
// engine composes its own loopback default — nothing to migrate).

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { isMap, parseDocument, Scalar, YAMLSeq } from 'yaml';

import { compareVersions } from './updater.js';

type OsNetworkInterfaceInfo = {
  family: string | number;
  internal?: boolean;
  address: string;
};

/** First upstream version whose schema bans wildcard binds (and drops webRuntime). */
export const MIN_LAN_BIND_VERSION = '0.2.1-alpha.5';

export const DEFAULT_BIND_HOST = '127.0.0.1';

/** Port the desktop spawns `dsh web` on (DSHD_PORT). */
export const DEFAULT_PORT = 3080;

/**
 * Adapter names the bind selector must never pick: proxy TUNs (Mihomo/Clash
 * pick fake-IP-ish addresses like 198.18.0.1), hypervisor/container/WSL
 * vswitches (unreachable from the physical LAN), and misc virtuals. Physical
 * WLAN/Ethernet names ("WLAN", "Ethernet 2", localized names) never match.
 */
const VIRTUAL_ADAPTER_RE =
  /mihomo|clash|sing-box|tun|tap|vethernet|wsl|hyper-?v|virtual|docker|vmware|virtualbox|loopback|bluetooth|wan ?miniport/i;

/** Address entry the selector works on — one non-internal IPv4 per adapter. */
export interface AdapterAddress {
  /** Adapter name as reported by os.networkInterfaces() keys. */
  name: string;
  /** Non-internal IPv4 literal. */
  address: string;
}

/** Is this a Tailscale CGNAT address (100.64.0.0/10)? */
export function isTailnetCgnat(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(address);
  if (!m) return false;
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/** Is this a bare IPv4 literal (the only kind the selector deals with)? */
export function isIpv4Literal(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

/**
 * Pure core: pick ONE bind address from the current non-internal IPv4s.
 * Physical LAN first (virtual-adapter names excluded, non-CGNAT), then any
 * tailnet CGNAT address (Tailscale), then loopback — ordering stable so
 * re-selection is deterministic for the same network state.
 */
export function selectBindHost(adapters: AdapterAddress[]): string {
  const physical = adapters.filter(
    (a) => !VIRTUAL_ADAPTER_RE.test(a.name) && isIpv4Literal(a.address) && !isTailnetCgnat(a.address),
  );
  if (physical.length > 0) return physical[0].address;
  const tailnet = adapters.filter(
    (a) => isIpv4Literal(a.address) && isTailnetCgnat(a.address),
  );
  if (tailnet.length > 0) return tailnet[0].address;
  return DEFAULT_BIND_HOST;
}

/** Snapshot of os.networkInterfaces() into AdapterAddress entries. */
export function currentAdapterAddresses(
  interfaces: NodeJS.Dict<OsNetworkInterfaceInfo[]> = networkInterfaces(),
): AdapterAddress[] {
  const out: AdapterAddress[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      const family = (addr as { family?: string | number }).family;
      if ((family === 'IPv4' || family === 4) && !(addr as { internal?: boolean }).internal) {
        out.push({ name, address: (addr as { address: string }).address });
      }
    }
  }
  return out;
}

/** The trusted-host entries the fence should admit for THIS network state. */
export function composeTrustedHosts(bindHost: string, adapters: AdapterAddress[]): string[] {
  const hosts: string[] = [bindHost];
  // The tailnet IPv4 stays whitelisted even when the bind is physical LAN:
  // a `tailscale serve` hop re-targets the listener via its proxy, and
  // direct tailnet reachability returning (bind selection change) should
  // not regress the fence. Harmless when unreachable.
  for (const a of adapters) {
    if (a.address !== bindHost && isIpv4Literal(a.address) && isTailnetCgnat(a.address)) {
      hosts.push(a.address);
    }
  }
  return [...new Set(hosts)];
}

export interface PatchLanBind {
  changed: boolean;
  /** New file text (identical to the input when unchanged). */
  text: string;
  /** Resolved webserver.host after the rewrite (null = entry untouched). */
  bindHost: string | null;
  /** Resolved connection.trustedHosts after the rewrite. */
  trustedHosts: string[] | null;
}

export interface ComposeLanBindOptions {
  bindHost: string;
  port: number;
  /** trustedHosts entries the fence must admit on this spawn. */
  trustedHosts: string[];
}

/**
 * Pure core: rewrite one patch text for the alpha.5 model. Malformed YAML
 * (or no top-level YAML sequence) is passed through unchanged — never a
 * destructive rewrite of a file we cannot parse. Only the webserver host and
 * the connection trustedHosts are touched; every other row, comment and
 * blank line survives byte-for-byte via the CST round-trip.
 */
export function composeLanBindPatch(
  patchText: string,
  options: ComposeLanBindOptions,
): PatchLanBind {
  const noChange: PatchLanBind = {
    changed: false,
    text: patchText,
    bindHost: null,
    trustedHosts: null,
  };
  const document = parseDocument(patchText, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  });
  if (document.errors.length > 0) return noChange;
  const contents = document.contents as { items?: unknown[] } | null;
  if (!contents || !Array.isArray(contents.items)) return noChange;

  const items = contents.items as Array<Record<string, unknown>>;
  let bindHost: string | null = null;
  let trustedHosts: string[] | null = null;

  for (let index = 0; index < items.length; index++) {
    if (!isMap(items[index] as never)) continue;
    const id = document.getIn([index, 'id']);
    if (id === 'webserver') {
      // Replace nodes wholesale with fresh plain scalars: setting a value
      // onto the existing node KEEPS its tag — a `!!js` port expression
      // would become `!!js 3080` (tag preserved, only the value swapped),
      // which the engine-side js-yaml v4 watcher still cannot parse.
      document.setIn([index, 'config', 'host'], new Scalar(options.bindHost));
      document.setIn([index, 'config', 'port'], new Scalar(options.port));
      bindHost = options.bindHost;
    } else if (id === 'connection') {
      // Preserve non-IP entries (MagicDNS names etc. the user/proxy layer
      // declared); drop stale IP literals replaced by the current values.
      // getIn returns a collection NODE (not a JS array) here — walk its
      // items (scalar nodes carry the value in `.value`); plain arrays cover
      // the already-JS shape at the write site.
      // getIn resolves scalar values to plain JS strings — a legacy `!!js`
      // expression (e.g. `!!js "[...ctx.webRuntime.trustedHosts, 'magic
      // .name.ts.net']"`) surfaces as ONE string; salvage its quoted
      // literals so declared hostnames survive the rewrite.
      const existing = document.getIn([index, 'config', 'trustedHosts']) as
        | { items?: unknown[] }
        | unknown[]
        | string
        | undefined;
      const rawList: string[] = typeof existing === 'string'
        ? (existing.match(/'([^']+)'/g) ?? []).map((quoted) => quoted.slice(1, -1))
        : Array.isArray(existing)
          ? existing.filter((e): e is string => typeof e === 'string')
          : (existing?.items ?? []).map((entry) => {
              if (typeof entry === 'string') return entry;
              const value = (entry as { value?: unknown }).value;
              return typeof value === 'string' ? value : '';
            });
      const preserved = rawList
        .filter((entry): entry is string => typeof entry === 'string' && entry !== '' && !isIpv4Literal(entry));
      const merged = [...new Set([...options.trustedHosts, ...preserved])];
      const seq = new YAMLSeq();
      seq.flow = false;
      for (const host of merged) seq.items.push(new Scalar(host));
      document.setIn([index, 'config', 'trustedHosts'], seq);
      trustedHosts = merged;
    }
  }

  if (bindHost === null && trustedHosts === null) return noChange;
  // Changed = the composed document differs from the input byte-for-byte —
  // identical values (the idempotent second run) write nothing.
  const text = String(document);
  if (text === patchText) {
    return { changed: false, text: patchText, bindHost, trustedHosts };
  }
  return { changed: true, text, bindHost, trustedHosts };
}

/** Outcome of the file-level migration (null = nothing to do / no engine ref). */
export interface LanBindOutcome {
  changed: boolean;
  /** The bind host written (kept as-is when unchanged). */
  bindHost: string | null;
  /** trustedHosts after the rewrite. */
  trustedHosts: string[] | null;
  /** Why the migration did not run (diagnostic only). */
  skipped?: 'old-engine' | 'no-engine-ref' | 'no-patch-file' | 'unparseable' | 'unchanged';
  /** Backup path when the file was rewritten. */
  backupPath?: string;
}

/**
 * File-level wrapper: version-gate on the closure actually being spawned,
 * select the bind address from the live network state, and rewrite
 * `profiles/<web>/cordis.patch.yml` when the declared values differ.
 * Atomic write (tmp + rename) with a timestamped `.pre-lan-bind-<ts>`
 * backup beside the original.
 * @param dshHome - DSH_HOME (user data root, e.g. ~/.dsh).
 * @param dshRoot - the dsh closure dist root dsh will spawn from (carries
 *   `.engine-ref.json`).
 * @param port - the port dsh will listen on (DSHD_PORT).
 * @param adapters - adapter snapshot override (tests inject a fixture; the
 *   default reads the live os.networkInterfaces()).
 */
export function migrateLanBind(
  dshHome: string,
  dshRoot: string,
  port: number = DEFAULT_PORT,
  adapters: AdapterAddress[] = currentAdapterAddresses(networkInterfaces()),
): LanBindOutcome | null {
  // Version gate: older closures still accept the wildcard compose (and
  // auto-derive trustedHosts from it) — never touch the user layer for them.
  let engineVersion: string | undefined;
  try {
    engineVersion = JSON.parse(readFileSync(join(dshRoot, '.engine-ref.json'), 'utf8'))
      ?.upstreamVersion;
  } catch {
    return { changed: false, bindHost: null, trustedHosts: null, skipped: 'no-engine-ref' };
  }
  if (typeof engineVersion !== 'string' || engineVersion === '') {
    return { changed: false, bindHost: null, trustedHosts: null, skipped: 'no-engine-ref' };
  }
  if (compareVersions(engineVersion, MIN_LAN_BIND_VERSION) < 0) {
    return { changed: false, bindHost: null, trustedHosts: null, skipped: 'old-engine' };
  }

  const bindHost = selectBindHost(adapters);
  const trustedHosts = composeTrustedHosts(bindHost, adapters);

  const patchFile = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  let patchText: string;
  try {
    patchText = readFileSync(patchFile, 'utf8');
  } catch {
    return { changed: false, bindHost, trustedHosts, skipped: 'no-patch-file' };
  }
  const migration = composeLanBindPatch(patchText, { bindHost, port, trustedHosts });
  if (!migration.changed) {
    return { changed: false, bindHost, trustedHosts, skipped: 'unchanged' };
  }

  const backupPath = `${patchFile}.pre-lan-bind-${Date.now()}`;
  copyFileSync(patchFile, backupPath);
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true });
  const tmpFile = `${patchFile}.tmp`;
  writeFileSync(tmpFile, migration.text, 'utf8');
  renameSync(tmpFile, patchFile);
  return { changed: true, bindHost: migration.bindHost, trustedHosts: migration.trustedHosts, backupPath };
}
