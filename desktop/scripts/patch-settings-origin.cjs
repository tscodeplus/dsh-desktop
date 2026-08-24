#!/usr/bin/env node
/**
 * patch-settings-origin.cjs — serve the web UI's settings/config surface to
 * LAN/Tailscale browsers ("settings are unavailable in this browser",
 * disabled Agent-preset dropdown).
 *
 * The client bundles mirror the server's loopback pin removed by
 * patch-connection-privileges.cjs: `ctx.connection.isLoopback` (page-origin
 * hostname) chooses "host" persistence (SettingsDescribeMirror /
 * SettingsScopeController backed by /api settings RPCs) ONLY on loopback;
 * otherwise "memory" — service no-ops, describe always "unavailable", writes
 * go nowhere, and the settings document (Agent preset dropdown) plus the
 * produced-files open-path button are never wired. The server fence already
 * admits the declared trustedHosts, so the client gate no longer matches it:
 * this patch rewrites the mode choice to "host" and wires the document
 * controller / open-path button on any origin.
 *
 * Naturally idempotent: every replacement anchors a state that no longer
 * exists after one pass, so re-running on a patched tree is a no-op.
 *
 * Usage: node scripts/patch-settings-origin.cjs <dsh-root | package-dir | file>
 *
 * SHIPPED IN DESKTOP BUILDS: release CI (desktop-release / engine-build) and
 * the local build scripts set DSHD_ENABLE_REMOTE_ACCESS=on, so released
 * closures carry this pass — fetch-dsh.cjs applies it ONLY when the value is
 * exactly 'on'; unset/off builds are upstream-pure dev closures (never ship
 * those).
 */

const fs = require('fs');
const path = require('path');

/** @type {ReadonlyArray<{desc: string, re: RegExp, to: (isSrc: boolean) => string}>} */
const PATCHES = [
  {
    desc: 'settings mirror/scope persistence -> host mode',
    re: /connection\.isLoopback\s*\?\s*['"]host['"]\s*:\s*['"]memory['"]/g,
    to: (isSrc) => (isSrc ? "'host'" : '"host"'),
  },
  {
    desc: 'settings document controller always wired (Agent preset dropdown)',
    re: /connection\.isLoopback\s*\?\s*new SettingsDocumentStore\(connection\.api,\s*ctx\.settingsScope\.describe\(\)\)\s*:\s*(?:void 0|undefined)/g,
    to: () => 'new SettingsDocumentStore(connection.api, ctx.settingsScope.describe())',
  },
  {
    desc: 'deliverables open-path button exposed on trust-fenced origins',
    re: /isLoopback && hostCanOpenPath/g,
    to: () => 'hostCanOpenPath',
  },
];

/**
 * Patch ONE file with all anchored replacements (per-rule match counts are
 * part of the log; zero matches for a rule is normal after the first pass).
 * @param {string} target - absolute file path.
 * @returns {boolean} true when any replacement was applied.
 */
function patchSettingsOriginFile(target) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    console.warn(`[patch-settings-origin] skip (unreadable): ${target} — ${error.message}`);
    return false;
  }
  const isSrc = /\.(ts|tsx)$/.test(target);
  let changed = false;
  for (const { desc, re, to } of PATCHES) {
    const matches = text.match(re);
    if (matches !== null && matches.length > 0) {
      text = text.replace(re, () => to(isSrc));
      console.log(`[patch-settings-origin] ${desc}: ${matches.length} hit(s) in ${target}`);
      changed = true;
    }
  }
  if (!changed) {
    console.log(`[patch-settings-origin] no-op (already patched / shape unchanged): ${target}`);
    return false;
  }
  fs.writeFileSync(target, text, 'utf8');
  return true;
}

/** Workspace-layout files of one dsh root (built runtime + vendored src). */
const WORKSPACE_FILES = [
  ['client', 'ui-settings', 'lib', 'client.js'],
  ['client', 'ui-settings', 'src', 'client', 'index.ts'],
  ['client', 'ui-settings', 'src', 'client', 'settings-scope.ts'],
  ['client', 'ui-settings-general', 'lib', 'client.js'],
  ['client', 'ui-settings-general', 'src', 'client', 'index.ts'],
  ['client', 'ui-deliverables', 'lib', 'client.js'],
  ['client', 'ui-deliverables', 'src', 'client', 'ProducedFiles.tsx'],
];

/**
 * Patch a dsh closure tree (workspace layout under packages/).
 * @param {string} dshDir - dsh root (`.dsh-build/dist` or a dsh release tree).
 * @returns {number} count of patched files.
 */
function patchSettingsOrigin(dshDir) {
  let patched = 0;
  for (const rel of WORKSPACE_FILES) {
    const target = path.join(dshDir, 'packages', ...rel);
    if (!fs.existsSync(target)) continue;
    if (patchSettingsOriginFile(target)) patched += 1;
  }
  return patched;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg !== undefined && /\.(js|ts|tsx)$/.test(arg)) {
    patchSettingsOriginFile(path.resolve(arg));
  } else if (arg !== undefined && fs.existsSync(arg)) {
    const root = path.resolve(arg);
    // A flat package dir (e.g. node_modules/@deepseek-ai/dsh-client-ui-settings)
    // carries only the built lib; a dsh root carries the workspace layout.
    patchSettingsOriginFile(path.join(root, 'lib', 'client.js'));
    patchSettingsOrigin(root);
  } else {
    const root = path.resolve(__dirname, '..', '.dsh-build', 'dist');
    patchSettingsOrigin(root);
  }
}

module.exports = { patchSettingsOrigin, patchSettingsOriginFile };
