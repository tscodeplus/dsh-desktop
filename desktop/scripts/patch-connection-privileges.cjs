#!/usr/bin/env node
/**
 * patch-connection-privileges.cjs — admit declared trustedHosts to dsh's
 * privileged /api method fence (the config plane).
 *
 * Upstream `dsh-client-connection` deliberately pins the privileged methods
 * (settings.*, agentPreset management, credentials.*, llm.discoverModels) to
 * loopback: the /api bridge re-checks those requests with an EMPTY trust
 * list — "the whole configuration plane stays loopback-same-origin until a
 * real authentication layer exists". The desktop's LAN/Tailscale feature
 * serves 0.0.0.0, so a LAN browser's settings describe/update gets 403
 * ("settings are unavailable in this browser" / "transport failure for
 * /api/settings.update: HTTP 403").
 *
 * This patch makes the privileged fence use the deployment's declared
 * `trustedHosts` (the admin-acknowledged authorities) instead of [],
 * keeping the DNS-rebinding/cross-site fences fully active and leaving the
 * loopback Fast-path unchanged. IT IS NOT AUTHENTICATION: any device that can
 * reach the deployment and present one of the declared authorities may then
 * read/mutate settings and probe discovery — the desktop's Phase 2 web-token
 * gate is the intended closure for that. Applied after every dsh rebuild by
 * fetch-dsh.cjs (idempotent, marker-anchored).
 *
 * Usage:  node scripts/patch-connection-privileges.cjs <dsh-root-or-ts-file>
 *         node scripts/patch-connection-privileges.cjs  # defaults to .dsh-build/dist
 *
 * SHIPPED IN DESKTOP BUILDS: release CI (desktop-release / engine-build) and
 * the local build scripts set DSHD_ENABLE_REMOTE_ACCESS=on, so released
 * closures carry this pass — fetch-dsh.cjs applies it ONLY when the value is
 * exactly 'on'; unset/off builds are upstream-pure dev closures (never ship
 * those).
 */

const fs = require('fs');
const path = require('path');

// Patched shapes (new and old) for idempotency and structure checks.
const NEW_GATE =
  'PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, trustedHosts)';
const GATE_RE = /PRIVILEGED_METHODS\.has\(method\)[\s\S]*?isTrustedApiRequest\(request, \[\]\)/;

/**
 * Patch ONE dsh-client-connection source/built file (idempotent).
 * @param {string} target - absolute .ts/.js path of the connection package.
 * @returns {boolean} true when patched, false when already patched / unmatched.
 */
function patchPrivilegedFenceFile(target) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    console.warn(`[patch-connection-privileges] skip (unreadable): ${target} — ${error.message}`);
    return false;
  }
  if (text.includes(NEW_GATE)) {
    console.log(`[patch-connection-privileges] already patched: ${target}`);
    return false;
  }
  const matches = text.match(GATE_RE);
  if (matches === null || matches.length !== 1) {
    console.warn(
      `[patch-connection-privileges] skip (privileged fence shape not found/ambiguous, `
      + `${matches === null ? 0 : matches.length} matches): ${target}`,
    );
    return false;
  }
  text = text.replace(GATE_RE, (region) => (
    region.replace('isTrustedApiRequest(request, [])', 'isTrustedApiRequest(request, trustedHosts)')
  ));
  if (target.endsWith('.ts')) {
    // Keep the vendored source doc in sync; non-fatal if the wording drifts.
    text = text.replace(
      /privileged methods additionally pass it with an empty trust list, which\s*\n?\s*\*?\s*pins them to loopback\./,
      'privileged methods additionally pass it with the deployment\'s full trust\n * list (dsh-desktop LAN/Tailscale patch; upstream pins them to loopback).',
    );
  }
  fs.writeFileSync(target, text, 'utf8');
  console.log(`[patch-connection-privileges] patched: ${target}`);
  return true;
}

/**
 * Patch the client-connection fence across a dsh closure tree (built runtime
 * lib + vendored src for consistency across rebuilds).
 * @param {string} dshDir - dsh root (`.dsh-build/dist` or a dsh release tree).
 * @returns {number} count of patched files.
 */
function patchConnectionPrivileges(dshDir) {
  let patched = 0;
  const targets = [
    // built runtime — what the spawned dsh executes
    path.join(dshDir, 'packages', 'client', 'connection', 'lib', 'index.js'),
    // vendored source — the next upstream rebuild regenerates lib from it
    path.join(dshDir, 'packages', 'client', 'connection', 'src', 'index.ts'),
  ];
  for (const target of targets) {
    if (patchPrivilegedFenceFile(target)) patched += 1;
  }
  return patched;
}

if (require.main === module) {
  const arg = process.argv[2];
  const root = arg !== undefined ? path.resolve(arg) : path.resolve(__dirname, '..', '.dsh-build', 'dist');
  patchConnectionPrivileges(root);
}

module.exports = { patchConnectionPrivileges, patchPrivilegedFenceFile };
