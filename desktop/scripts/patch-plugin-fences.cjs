#!/usr/bin/env node
/**
 * patch-plugin-fences.cjs — admit the deployment's declared trustedHosts to
 * web-plugin request fences and connection channels (the "plugin API 403 from
 * LAN" class).
 *
 * The /api fence and its privileged methods admit the deployment `trustedHosts`
 * (patch-connection-privileges.cjs), but plugin-owned surfaces are OUTSIDE that
 * fence and stay loopback-pinned:
 *
 *   · dsh-web-plugin-manager serves /api2/plugin-manager/* through its own
 *     request fence: Host must be loopback or one of the hosts named in its
 *     DSH_PLUGIN_MANAGER_TRUSTED_HOSTS env contract. A LAN/Tailscale browser
 *     never appears there, so every call 403s
 *     ("pluginManager.listProfiles: HTTP 403", "listKinds: HTTP 403").
 *   · a plugin registering a connection channel with authority: "loopback"
 *     (the "config plane" policy) is pinned to loopback by an EMPTY trust list
 *     in rpc-host.ts, even on a LAN deployment.
 *
 * This pass closes both, consistently with patch-connection-privileges (the
 * declared authorities are ever the deployment's admin-acknowledged fences; no
 * auth — Phase 2 web-token gate remains the closure):
 *
 *  1. publish — client-connection apply() exports the resolved trustedHosts
 *     (auto-derived LAN/Tailscale IP literals + the profile's MagicDNS names)
 *     as comma-separated hostnames into DSH_PLUGIN_MANAGER_TRUSTED_HOSTS (the
 *     plugin's documented contract) and DSH_TRUSTED_HOSTS (the dsh-desktop
 *     convention for future plugin-owned fences). Hostname-only, because plugin
 *     fences compare the browser Host header's hostname and because port-less
 *     authorities match every port (exactly the shape the dsh CLI derives).
 *  2. relax — loopback-authority connection channels admit the deployment
 *     trustedHosts when the deployment declares any (no declaration => the
 *     upstream loopback pin stands unchanged; LAN-off deployments are
 *     byte-identical to upstream).
 *
 * Usage:  node scripts/patch-plugin-fences.cjs <dsh-root-or-file>
 *         node scripts/patch-plugin-fences.cjs   # defaults to .dsh-build/dist
 *
 * SHIPPED IN DESKTOP BUILDS: release CI (desktop-release / engine-build) and
 * the local build scripts set DSHD_ENABLE_REMOTE_ACCESS=on, so released
 * closures carry this pass — fetch-dsh.cjs applies it ONLY when the value is
 * exactly 'on'; unset/off builds are upstream-pure dev closures (never ship
 * those).
 */

const fs = require('fs');
const path = require('path');

// Marker for the publish block; its presence signals an already-patched file.
const ENV_MARK = 'DSH_PLUGIN_MANAGER_TRUSTED_HOSTS';

// Source form (packages/*/src/**: strict TS, single quotes, 2-space indent).
// Both quotes/parens forms below use brace-agnostic regexes so the same steps
// handle src (4-space indent inside methods) and the built bundle.
const SRC_PUBLISH = `
  // dsh-desktop LAN/Tailscale patch: publish the deployment's declared
  // trusted-host authorities (LAN/Tailscale IP literals + MagicDNS names) as
  // comma-separated hostnames so plugin-owned request fences that cannot read
  // the connection config (e.g. dsh-web-plugin-manager's
  // DSH_PLUGIN_MANAGER_TRUSTED_HOSTS) admit the same origins as the /api
  // fence. Hostname-only: plugin fences compare the browser Host header's
  // hostname, and a port-less authority matches every port anyway.
  const pluginTrustHostnames = trustedHosts.map((entry) => {
    try {
      return new URL(\`http://\${entry}\`).hostname
    } catch {
      return undefined
    }
  }).filter((hostname): hostname is string => hostname !== undefined).join(',')
  process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = pluginTrustHostnames
  process.env.DSH_TRUSTED_HOSTS = pluginTrustHostnames
`;

// Built-bundle form (tsdown output: double quotes, semi-colons, tab indent,
// `void 0` for undefined).
const LIB_PUBLISH = `
	// dsh-desktop LAN/Tailscale patch: publish the deployment's declared
	// trusted-host authorities (LAN/Tailscale IP literals + MagicDNS names) as
	// comma-separated hostnames so plugin-owned request fences that cannot read
	// the connection config (e.g. dsh-web-plugin-manager's
	// DSH_PLUGIN_MANAGER_TRUSTED_HOSTS) admit the same origins as the /api
	// fence. Hostname-only: plugin fences compare the browser Host header's
	// hostname, and a port-less authority matches every port anyway.
	const pluginTrustHostnames = trustedHosts.map((entry) => {
		try {
			return new URL('http://' + entry).hostname;
		} catch {
			return void 0;
		}
	}).filter((hostname) => hostname !== void 0).join(',');
	process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = pluginTrustHostnames;
	process.env.DSH_TRUSTED_HOSTS = pluginTrustHostnames;
`;

// The upstream loopback pin: `isTrustedApiRequest(request, [])` (empty trust
// list) on the shared-/api-interceptor branch and `? [] : this.trustedHosts`
// on the dedicated-channel register. Both exist exactly once per file.
const LOOPBACK_TRUST_RE = /isTrustedApiRequest\(request, \[\]\)/;
// g-flag so match() returns one element PER OCCURRENCE (a capture group would
// otherwise inflate the array with groups and break the single-occurrence
// check below — that exact trap hit the first cut of this pass).
const REGISTER_TRUST_RE = /options\.authority\s*===\s*(["'])loopback\1\s*\?\s*\[\]\s*:\s*this\.trustedHosts/g;

// Guarded replacements: the upstream empty-list check stays in place for
// loopback-only deployments (trustedHosts empty = upstream-identical); a LAN
// deployment (trustedHosts declared) admits its declared authorities instead.
const LOOPBACK_TRUST_TO = 'isTrustedApiRequest(request, this.trustedHosts.length === 0 ? [] : this.trustedHosts)';
const REGISTER_TRUST_TO = (quote) => (
  'options.authority === ' + quote + 'loopback' + quote
  + ' && this.trustedHosts.length === 0 ? [] : this.trustedHosts'
);

/**
 * Patch ONE dsh-client-connection source/built file (idempotent).
 * Steps run independently: publish (index only), interceptor relax, register
 * relax (rpc-host only); a shape drift in one step skips that step with a
 * warning instead of aborting the file.
 * @param {string} target - absolute .ts/.js path of the connection package.
 * @returns {boolean} true when any step patched, false when nothing changed.
 */
function patchPluginFenceFile(target) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    console.warn(`[patch-plugin-fences] skip (unreadable): ${target} — ${error.message}`);
    return false;
  }
  const isSrc = target.endsWith('.ts');
  let changed = false;

  // 1. Publish the deployment trustedHosts to the plugin process env.
  if (!text.includes(ENV_MARK)) {
    const anchor = isSrc
      ? '  for (const entry of trustedHosts) assertTrustedAuthority(entry)\n'
      : '\tfor (const entry of trustedHosts) assertTrustedAuthority(entry);\n';
    if (text.includes(anchor)) {
      text = text.replace(anchor, anchor + (isSrc ? SRC_PUBLISH : LIB_PUBLISH));
      console.log(`[patch-plugin-fences] publish DSH_PLUGIN_MANAGER_TRUSTED_HOSTS (${ENV_MARK}): ${target}`);
      changed = true;
    } else {
      console.warn(`[patch-plugin-fences] skip (publish anchor not found): ${target}`);
    }
  } else {
    console.log(`[patch-plugin-fences] already patched (publish): ${target}`);
  }

  // 2. Shared-/api interceptor fence: admit declared trustedHosts on a
  //    loopback-authority interceptor.
  if (!text.includes(LOOPBACK_TRUST_TO)) {
    const matches = text.match(LOOPBACK_TRUST_RE);
    if (matches !== null && matches.length === 1) {
      text = text.replace(LOOPBACK_TRUST_RE, LOOPBACK_TRUST_TO);
      console.log(`[patch-plugin-fences] relax /api interceptor loopback fence: ${target}`);
      changed = true;
    } else {
      console.warn(
        `[patch-plugin-fences] skip (interceptor fence shape not found/ambiguous, `
        + `${matches === null ? 0 : matches.length} matches): ${target}`,
      );
    }
  } else {
    console.log(`[patch-plugin-fences] already patched (interceptor): ${target}`);
  }

  // 3. Dedicated-channel register fence: same relaxation (keep the file's own
  //    quote style — tsdown bundles use double quotes, vendored src single).
  //    NOTE: the skip check is a regex over the GUARDED register shape — the
  //    interceptor replacement above also contains a "length === 0 ? [] :"
  //    fragment, so a substring check would wrongly skip this step.
  const RELAXED_REGISTER_RE = /options\.authority\s*===\s*(["'])loopback\1\s*&&\s*this\.trustedHosts\.length\s*===\s*0\s*\?\s*\[\]\s*:\s*this\.trustedHosts/;
  if (!RELAXED_REGISTER_RE.test(text)) {
    const matches = text.match(REGISTER_TRUST_RE);
    if (matches !== null && matches.length === 1) {
      const quote = matches[0].includes('"') ? '"' : "'";
      text = text.replace(REGISTER_TRUST_RE, () => REGISTER_TRUST_TO(quote));
      console.log(`[patch-plugin-fences] relax rpc channel loopback fence: ${target}`);
      changed = true;
    } else {
      console.warn(
        `[patch-plugin-fences] skip (channel fence shape not found/ambiguous, `
        + `${matches === null ? 0 : matches.length} matches): ${target}`,
      );
    }
  } else {
    console.log(`[patch-plugin-fences] already patched (channel): ${target}`);
  }

  if (changed) fs.writeFileSync(target, text, 'utf8');
  return changed;
}

/**
 * Patch the client-connection fences across a dsh closure tree (built runtime
 * lib + vendored src for consistency across rebuilds) — the same coverage
 * patch-connection-privileges.cjs uses.
 * @param {string} dshDir - dsh root (`.dsh-build/dist` or a dsh release tree).
 * @returns {number} count of patched files.
 */
function patchPluginFences(dshDir) {
  let patched = 0;
  const targets = [
    // built runtime — what the spawned dsh executes
    path.join(dshDir, 'packages', 'client', 'connection', 'lib', 'index.js'),
    // vendored sources — the next upstream rebuild regenerates lib from them
    path.join(dshDir, 'packages', 'client', 'connection', 'src', 'index.ts'),
    path.join(dshDir, 'packages', 'client', 'connection', 'src', 'rpc-host.ts'),
  ];
  for (const target of targets) {
    if (patchPluginFenceFile(target)) patched += 1;
  }
  return patched;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg !== undefined && /\.[jt]s$/.test(arg)) {
    patchPluginFenceFile(path.resolve(arg));
  } else {
    const root = arg !== undefined ? path.resolve(arg) : path.resolve(__dirname, '..', '.dsh-build', 'dist');
    patchPluginFences(root);
  }
}

module.exports = { patchPluginFences, patchPluginFenceFile };
