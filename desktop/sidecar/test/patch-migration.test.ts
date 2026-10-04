// Tests for the profile-patch pre-flight migration
// (desktop/sidecar/src/patch-migration.ts).
//
// The stale row class: an older plugin-management arrangement left
// `- id: plugin-manager / disabled: true` in the user's profile patch layer;
// since upstream 0.2.x the agent presets enable tool-plugin-manager, which
// waits forever on the (now disabled) host pluginManager service. The
// migration removes that one row — and ONLY that row — from the user layer,
// version-gated on the closure being spawned.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MIN_MIGRATE_VERSION,
  migrateStalePluginManagerDisable,
  removeStalePluginManagerDisable,
} from '../src/patch-migration.js';
import { compareVersions } from '../src/updater.js';

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-migration-test-'));
  homes.push(dir);
  return dir;
}

function writePatch(home: string, text: string): string {
  const dir = join(home, 'profiles', 'web');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cordis.patch.yml');
  writeFileSync(file, text, 'utf8');
  return file;
}

function writeEngineRef(root: string, upstreamVersion: string): void {
  writeFileSync(
    join(root, '.engine-ref.json'),
    JSON.stringify({ ref: 'x'.repeat(40), upstreamVersion }),
    'utf8',
  );
}

/** The exact stale composition from a real install (2026-10-04 diagnosis). */
const REAL_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# LAN/Tailscale reachability (added 2026-08-24, see cordis.patch.yml.bak):
# - webserver: bind all interfaces (schema allows '0.0.0.0'; the CLI's
#   --host 0.0.0.0 ban only guards the flag path — deployments layer config).
#   With 0.0.0.0 the trust fence auto-derives LAN + Tailscale IP literals.
# - connection: extend trustedHosts with the MagicDNS name so \`tailscale
#   serve\` hops (Host = desktop-141inli.taile940d7.ts.net) pass the /api fence.
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
- id: connection
  config:
    # NOTE: the array expression must be QUOTED — unquoted \`!!js [...]\` parses
    # as a YAML flow-sequence node (kind=sequence) and js-yaml v4 then fails
    # "unknown tag" because the !!js type is registered for scalars only.
    trustedHosts: !!js "[...ctx.webRuntime.trustedHosts, 'desktop-141inli.taile940d7.ts.net']"
# dsh-plugin-manager:managed:start
- id: plugin-manager
  disabled: true
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode
    model: nemotron-3.5-lightning-free
# dsh-plugin-manager:managed:end
`;

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('removeStalePluginManagerDisable (pure core)', () => {
  it('removes the stale disable row and keeps everything else, comments and !!js intact', () => {
    const migration = removeStalePluginManagerDisable(REAL_PATCH);
    expect(migration.changed).toBe(true);
    expect(migration.removedIds).toEqual(['plugin-manager']);
    // The stale row and its two lines are gone...
    expect(migration.text).not.toMatch(/- id: plugin-manager/);
    expect(migration.text).not.toMatch(/^\s*disabled: true\s*$/m);
    // ...the LAN/Tailscale config survives verbatim (text + !!js tags)...
    expect(migration.text).toContain('host: \'0.0.0.0\'');
    expect(migration.text).toContain('!!js ctx.webStartup.port ?? 3080');
    expect(migration.text).toContain(
      '!!js "[...ctx.webRuntime.trustedHosts, \'desktop-141inli.taile940d7.ts.net\']"',
    );
    // ...user settings rows survive...
    expect(migration.text).toContain('nemotron-3.5-lightning-free');
    expect(migration.text).toContain('welcomeNoticeVersion: 2026-08-13.1');
    // ...and so do the leading comments.
    expect(migration.text).toContain('# Your patch layer for this dsh profile');
    expect(migration.text).toContain('# dsh-plugin-manager:managed:start');
  });

  it('is idempotent: an already-clean patch passes through unchanged', () => {
    const once = removeStalePluginManagerDisable(REAL_PATCH);
    const twice = removeStalePluginManagerDisable(once.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it('leaves a name-qualified disable of ANOTHER module alone', () => {
    const text = `- id: plugin-manager
  name: "@some/other-implementation"
  disabled: true
`;
    expect(removeStalePluginManagerDisable(text)).toMatchObject({ changed: false });
  });

  it('leaves non-boolean disabled forms (e.g. !!js expressions) alone', () => {
    const text = `- id: plugin-manager
  disabled: !!js "!ctx.get('profileContext')"
`;
    expect(removeStalePluginManagerDisable(text)).toMatchObject({ changed: false });
    expect(removeStalePluginManagerDisable(text).text).toContain("!!js \"!ctx.get('profileContext')\"");
  });

  it('does not touch tool-plugin-manager rows (different id)', () => {
    const text = `- id: tool-plugin-manager
  name: "@deepseek-ai/dsh-plugin-manager/tools"
  disabled: true
`;
    expect(removeStalePluginManagerDisable(text)).toMatchObject({ changed: false });
  });

  it('removes the row even with the upstream module name spelled out', () => {
    const text = `- id: plugin-manager
  name: "@deepseek-ai/dsh-plugin-manager"
  disabled: true
`;
    const migration = removeStalePluginManagerDisable(text);
    expect(migration.changed).toBe(true);
    expect(migration.text).not.toMatch(/- id: plugin-manager/);
  });

  it('tolerates rows in any order and only removes matching ones', () => {
    const text = `- id: alpha
  config:
    a: 1
- id: plugin-manager
  disabled: true
- id: beta
  disabled: false
`;
    const migration = removeStalePluginManagerDisable(text);
    expect(migration.changed).toBe(true);
    expect(migration.text).toContain('- id: alpha');
    expect(migration.text).toContain('- id: beta');
    expect(migration.text).toContain('disabled: false');
  });

  it('passes malformed YAML through untouched (never rewrite what we cannot parse)', () => {
    const text = '- id: webserver\n    [broken: : : yaml\n';
    const migration = removeStalePluginManagerDisable(text);
    expect(migration.changed).toBe(false);
    expect(migration.text).toBe(text);
  });

  it('passes non-sequence documents through untouched', () => {
    const text = 'just: a-map\n';
    expect(removeStalePluginManagerDisable(text)).toMatchObject({ changed: false });
  });
});

describe('migrateStalePluginManagerDisable (file wrapper)', () => {
  it('rewrites the patch, creates a timestamped backup, and stays atomic', () => {
    const home = tempHome();
    const root = join(home, 'closure');
    mkdirSync(root, { recursive: true });
    writeEngineRef(root, '0.2.1-alpha.1');
    const patchFile = writePatch(home, REAL_PATCH);

    const outcome = migrateStalePluginManagerDisable(home, root);
    expect(outcome).not.toBeNull();
    expect(outcome?.changed).toBe(true);
    expect(outcome?.removedIds).toEqual(['plugin-manager']);
    expect(outcome?.backupPath).toBeDefined();
    expect(existsSync(outcome?.backupPath ?? '')).toBe(true);
    // Backup holds the original; the live file is migrated.
    expect(readFileSync(outcome?.backupPath ?? '', 'utf8')).toBe(REAL_PATCH);
    const migrated = readFileSync(patchFile, 'utf8');
    expect(migrated).not.toMatch(/- id: plugin-manager/);
    expect(migrated).toContain("host: '0.0.0.0'");
    // No tmp leftovers.
    expect(existsSync(`${patchFile}.tmp`)).toBe(false);
  });

  it('no-ops below the gate version', () => {
    const home = tempHome();
    const root = join(home, 'closure');
    mkdirSync(root, { recursive: true });
    writeEngineRef(root, '0.1.2-alpha.1');
    writePatch(home, REAL_PATCH);
    expect(compareVersions('0.1.2-alpha.1', MIN_MIGRATE_VERSION)).toBeLessThan(0);
    expect(migrateStalePluginManagerDisable(home, root)).toBeNull();
  });

  it('no-ops when the closure carries no .engine-ref.json', () => {
    const home = tempHome();
    const root = join(home, 'closure');
    mkdirSync(root, { recursive: true });
    writePatch(home, REAL_PATCH);
    expect(migrateStalePluginManagerDisable(home, root)).toBeNull();
  });

  it('no-ops when the profile patch does not exist', () => {
    const home = tempHome();
    const root = join(home, 'closure');
    mkdirSync(root, { recursive: true });
    writeEngineRef(root, '0.2.1');
    expect(migrateStalePluginManagerDisable(home, root)).toBeNull();
  });

  it('no-ops (and does not touch the file) when the patch is already clean', () => {
    const home = tempHome();
    const root = join(home, 'closure');
    mkdirSync(root, { recursive: true });
    writeEngineRef(root, '0.2.1');
    const clean = removeStalePluginManagerDisable(REAL_PATCH).text;
    const patchFile = writePatch(home, clean);
    expect(migrateStalePluginManagerDisable(home, root)).toBeNull();
    expect(readFileSync(patchFile, 'utf8')).toBe(clean);
  });
});
