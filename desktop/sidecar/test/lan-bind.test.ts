// Tests for the LAN bind pre-flight migration (desktop/sidecar/src/lan-bind.ts).
//
// Engine 0.2.1-alpha.5 bans wildcard webserver binds at the config schema
// level and dropped the webRuntime service that auto-derived trustedHosts —
// the migration rewrites the user patch layer's webserver host (one concrete
// interface address) and connection trustedHosts, preserving everything else.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  composeLanBindPatch,
  composeTrustedHosts,
  isIpv4Literal,
  isTailnetCgnat,
  MIN_LAN_BIND_VERSION,
  migrateLanBind,
  selectBindHost,
  type AdapterAddress,
} from '../src/lan-bind.js';
import { compareVersions } from '../src/updater.js';

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lan-bind-test-'));
  homes.push(dir);
  return dir;
}

const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# LAN/Tailscale reachability head comment must survive untouched.
- id: webserver
  config:
    host: '0.0.0.0'
    port: 3080
- id: connection
  config:
    trustedHosts:
      - 0.0.0.0
      - desktop-141inli.taile940d7.ts.net
# A user settings row after the LAN rows must survive untouched.
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
`;

const PATCH_WITH_JS = `# pre-seed layer with the legacy custom-tag scalars
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
- id: connection
  config:
    trustedHosts: !!js "[...ctx.webRuntime.trustedHosts, 'magic.name.ts.net']"
`;

function adapters(...entries: [string, string][]): AdapterAddress[] {
  return entries.map(([name, address]) => ({ name, address }));
}

describe('selectBindHost', () => {
  it('prefers the physical LAN adapter (virtual adapter names skipped)', () => {
    expect(
      selectBindHost(
        adapters(
          ['Mihomo', '198.18.0.1'],
          ['WLAN 2', '192.168.1.203'],
          ['vEthernet (Default Switch)', '172.27.48.1'],
        ),
      ),
    ).toBe('192.168.1.203');
  });

  it('falls back to the tailnet CGNAT address when no physical adapter exists', () => {
    expect(selectBindHost(adapters(['Mihomo', '198.18.0.1'], ['Tailscale', '100.125.47.56']))).toBe(
      '100.125.47.56',
    );
  });

  it('falls back to loopback when only virtual adapters exist', () => {
    expect(selectBindHost(adapters(['Mihomo', '198.18.0.1']))).toBe('127.0.0.1');
  });

  it('returns loopback with no adapters at all', () => {
    expect(selectBindHost([])).toBe('127.0.0.1');
  });

  it('bindAdapter=tailscale prefers the tailnet CGNAT address', () => {
    expect(
      selectBindHost(
        adapters(
          ['Mihomo', '198.18.0.1'],
          ['WLAN 2', '192.168.1.203'],
          ['Tailscale', '100.125.47.56'],
        ),
        'tailscale',
      ),
    ).toBe('100.125.47.56');
  });

  it('bindAdapter=tailscale falls back to LAN when no tailnet adapter exists', () => {
    expect(selectBindHost(adapters(['WLAN 2', '192.168.1.203']), 'tailscale')).toBe(
      '192.168.1.203',
    );
  });

  it('bindAdapter=tailscale still works when the tailnet IP is the ONLY adapter', () => {
    expect(selectBindHost(adapters(['Tailscale', '100.125.47.56']), 'tailscale')).toBe(
      '100.125.47.56',
    );
  });

  it('skips tailnet addresses when picking physical (never binds CGNAT as LAN)', () => {
    expect(
      selectBindHost(adapters(['vEthernet (WSL)', '172.27.48.1'], ['Tailscale', '100.101.1.1'])),
    ).toBe('100.101.1.1');
  });
});

describe('composeTrustedHosts', () => {
  it('always includes the bind host plus the tailnet IPv4s', () => {
    const list = composeTrustedHosts(
      '192.168.1.203',
      adapters(['WLAN 2', '192.168.1.203'], ['Tailscale', '100.125.47.56'], ['Mihomo', '198.18.0.1']),
    );
    expect(list).toContain('192.168.1.203');
    expect(list).toContain('100.125.47.56');
    // Virtual proxy adapters are never trusted.
    expect(list).not.toContain('198.18.0.1');
  });

  it('dedupes when the bind host is itself a tailnet address', () => {
    const list = composeTrustedHosts(
      '100.125.47.56',
      adapters(['Tailscale', '100.125.47.56']),
    );
    expect(list).toEqual(['100.125.47.56']);
  });
});

describe('composeLanBindPatch', () => {
  it('rewrites host to the concrete value and statically lists trustedHosts', () => {
    const result = composeLanBindPatch(PATCH_TEMPLATE, {
      bindHost: '192.168.1.203',
      port: 3080,
      trustedHosts: ['192.168.1.203', '100.125.47.56'],
    });
    expect(result.changed).toBe(true);
    expect(result.bindHost).toBe('192.168.1.203');
    expect(result.trustedHosts).toEqual(['192.168.1.203', '100.125.47.56', 'desktop-141inli.taile940d7.ts.net']);
    const text = result.text;
    expect(text).toContain('host: 192.168.1.203');
    expect(text).not.toContain('0.0.0.0');
    // Preserved hostname entries survive the IP rewrite.
    expect(text).toContain('desktop-141inli.taile940d7.ts.net');
    // Block style (not flow) sequences.
    expect(text).toMatch(/trustedHosts:\n {6}- /);
    // Untouched rows and comments survive.
    expect(text).toContain('preference: dark');
    expect(text).toContain('LAN/Tailscale reachability head comment must survive untouched.');
  });

  it('replaces legacy !!js interpolations with plain values', () => {
    const result = composeLanBindPatch(PATCH_WITH_JS, {
      bindHost: '192.168.1.203',
      port: 3080,
      trustedHosts: ['192.168.1.203'],
    });
    expect(result.changed).toBe(true);
    // Both custom-tag scalars are gone (comment text aside).
    expect(result.text.replace(/^#.*$/gm, '')).not.toContain('!!js');
    expect(result.text).toContain('host: 192.168.1.203');
    expect(result.text).toContain('port: 3080');
    // The MagicDNS name from the old interpolation is preserved as a static entry.
    expect(result.text).toContain('magic.name.ts.net');
  });

  it('is idempotent: a second run with the same values changes nothing', () => {
    const first = composeLanBindPatch(PATCH_TEMPLATE, {
      bindHost: '192.168.1.203',
      port: 3080,
      trustedHosts: ['192.168.1.203', '100.125.47.56', 'desktop-141inli.taile940d7.ts.net'],
    });
    const second = composeLanBindPatch(first.text, {
      bindHost: '192.168.1.203',
      port: 3080,
      trustedHosts: ['192.168.1.203', '100.125.47.56'],
    });
    expect(second.changed).toBe(false);
  });

  it('passes malformed YAML through unchanged', () => {
    const result = composeLanBindPatch('- [unclosed, {\n  host: x', {
      bindHost: '192.168.1.203',
      port: 3080,
      trustedHosts: ['192.168.1.203'],
    });
    expect(result.changed).toBe(false);
    expect(result.text).toBe('- [unclosed, {\n  host: x');
  });

  it('passes a non-sequence document through unchanged', () => {
    const result = composeLanBindPatch('# just a comment\n', {
      bindHost: '192.168.1.203',
      port: 3080,
      trustedHosts: ['192.168.1.203'],
    });
    expect(result.changed).toBe(false);
  });

  it('is a no-op when neither webserver nor connection rows exist', () => {
    const result = composeLanBindPatch(PATCH_TEMPLATE.slice(
      PATCH_TEMPLATE.indexOf('- id: ui-theme'),
    ), {
      bindHost: '192.168.1.203',
      port: 3080,
      trustedHosts: ['192.168.1.203'],
    });
    expect(result.changed).toBe(false);
    expect(result.text).toContain('preference: dark');
  });
});

describe('migrateLanBind (file level)', () => {
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function setup(home: string, patchText: string): void {
    const dir = join(home, 'profiles', 'web');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cordis.patch.yml'), patchText, 'utf8');
  }

  function writeEngineRef(root: string, upstreamVersion: string): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, '.engine-ref.json'),
      JSON.stringify({ ref: 'x'.repeat(40), upstreamVersion }),
      'utf8',
    );
  }

  it('rewrites the patch file and leaves a timestamped backup', () => {
    const home = tempHome();
    setup(home, PATCH_TEMPLATE);
    const root = join(home, 'engine', 'dsh-dist');
    writeEngineRef(root, '0.2.1-alpha.5');

    // Stub adapter fixtures (tests must not depend on the host's
    // interfaces): physical LAN wins over the tailnet CGNAT; the outcome
    // proves the file-level plumbing (gate, backup, rewrite).
    const outcome = migrateLanBind(
      home,
      root,
      3080,
      adapters(
        ['Mihomo', '198.18.0.1'],
        ['WLAN 2', '192.168.1.203'],
        ['Tailscale', '100.125.47.56'],
      ),
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.changed).toBe(true);
    expect(outcome?.bindHost).toBe('192.168.1.203');
    expect(outcome?.trustedHosts).toEqual([
      '192.168.1.203',
      '100.125.47.56',
      'desktop-141inli.taile940d7.ts.net',
    ]);
    const rewritten = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    expect(rewritten).toContain('host: 192.168.1.203');
    expect(rewritten).toContain('- 100.125.47.56');
    expect(rewritten).toContain('desktop-141inli.taile940d7.ts.net');
    const backups = existsBackups(home);
    expect(backups.length).toBe(1);
    // The backup carries the ORIGINAL text.
    expect(readFileSync(backups[0], 'utf8')).toBe(PATCH_TEMPLATE);
  });

  it('bindAdapter=tailscale writes the tailnet address at file level', () => {
    const home = tempHome();
    setup(home, PATCH_TEMPLATE);
    const root = join(home, 'engine', 'dsh-dist');
    writeEngineRef(root, MIN_LAN_BIND_VERSION);
    const outcome = migrateLanBind(
      home,
      root,
      3080,
      adapters(['WLAN 2', '192.168.1.203'], ['Tailscale', '100.125.47.56']),
      'tailscale',
    );
    expect(outcome?.bindHost).toBe('100.125.47.56');
    // Preserved hostname entries survive; the NON-bound physical LAN IP is
    // not whitelisted (it has no listener under the single-bind model).
    expect(outcome?.trustedHosts).toEqual(['100.125.47.56', 'desktop-141inli.taile940d7.ts.net']);
    const rewritten = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    expect(rewritten).toContain('host: 100.125.47.56');
    expect(rewritten).not.toContain('host: 192.168.1.203');
    expect(rewritten).not.toMatch(/- 192\.168\.1\.203/);
  });

  it('is idempotent: the second run skips (unchanged) without a new backup', () => {
    const home = tempHome();
    setup(home, PATCH_TEMPLATE);
    const root = join(home, 'engine', 'dsh-dist');
    writeEngineRef(root, MIN_LAN_BIND_VERSION);
    const stubAdapters = adapters(['WLAN 2', '192.168.1.203']);
    migrateLanBind(home, root, 3080, stubAdapters);
    const second = migrateLanBind(home, root, 3080, stubAdapters);
    expect(second?.changed).toBe(false);
    expect(second?.skipped).toBe('unchanged');
    expect(existsBackups(home).length).toBe(1);
  });

  it('skips old-engine closures without touching the patch file', () => {
    const home = tempHome();
    setup(home, PATCH_TEMPLATE);
    const root = join(home, 'engine', 'dsh-dist');
    writeEngineRef(root, '0.2.1-alpha.1');
    const outcome = migrateLanBind(home, root, 3080);
    expect(outcome?.skipped).toBe('old-engine');
    expect(outcome?.changed).toBe(false);
    expect(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toBe(
      PATCH_TEMPLATE,
    );
  });

  it('skips when the closure carries no engine ref', () => {
    const home = tempHome();
    setup(home, PATCH_TEMPLATE);
    const root = join(home, 'engine', 'dsh-dist');
    const outcome = migrateLanBind(home, root, 3080);
    expect(outcome?.skipped).toBe('no-engine-ref');
    expect(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toBe(
      PATCH_TEMPLATE,
    );
  });

  it('skips when no patch file exists (fresh install)', () => {
    const home = tempHome();
    const root = join(home, 'engine', 'dsh-dist');
    writeEngineRef(root, MIN_LAN_BIND_VERSION);
    const outcome = migrateLanBind(home, root, 3080);
    expect(outcome?.skipped).toBe('no-patch-file');
  });
});

/** Backup files left beside the patch file. */
function existsBackups(home: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(join(home, 'profiles', 'web'))
    .filter((f: string) => f.startsWith('cordis.patch.yml.pre-lan-bind-'))
    .map((f: string) => join(home, 'profiles', 'web', f));
}

describe('version gate and IP classifiers', () => {
  it('gates at exactly the first wildcard-banning release and classifies IPs', () => {
    expect(MIN_LAN_BIND_VERSION).toBe('0.2.1-alpha.5');
    expect(compareVersions(MIN_LAN_BIND_VERSION, '0.2.1-alpha.5')).toBeLessThanOrEqual(0);
    expect(isIpv4Literal('192.168.1.203')).toBe(true);
    expect(isIpv4Literal('magic.name.ts.net')).toBe(false);
    expect(isTailnetCgnat('100.125.47.56')).toBe(true);
    expect(isTailnetCgnat('192.168.1.203')).toBe(false);
    expect(isTailnetCgnat('100.63.0.1')).toBe(false);
    expect(isTailnetCgnat('100.128.0.1')).toBe(false);
  });
});
