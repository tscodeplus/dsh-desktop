#!/usr/bin/env node
/**
 * patch-webui-index.cjs — inject the dsh-desktop secure-context shim into the
 * web UI index.html.
 *
 * LAN/Tailscale reachability (desktop feature) serves the web UI over plain
 * HTTP on a machine IP. That origin is NOT a browser "secure context", where
 * globalThis.crypto.randomUUID does not exist — and the UI's RPC and message
 * layers call it for ids, so settings/provider-catalog/agent-preset pages die
 * with "crypto.randomUUID is not a function". The shim derives an RFC 4122 v4
 * UUID from crypto.getRandomValues (available in every context) and is a
 * no-op on secure contexts (localhost/HTTPS), where the native method exists.
 *
 * Patches the built dist dsh web actually serves (apps/web/dist/index.html)
 * and the vite source template (apps/web/index.html) so future rebuilds keep
 * it — fetch-dsh.cjs calls patchWebUiIndex after `pnpm run build`.
 * Idempotent: the block carries a marker attribute; already-patched files are
 * skipped. The index is read from disk per request (frontend-static render),
 * so a running dsh picks it up without a restart.
 *
 * Usage:  node scripts/patch-webui-index.cjs <dsh-root-or-html-file>
 *         node scripts/patch-webui-index.cjs          # defaults to .dsh-build/dist
 *
 * SHIPPED IN DESKTOP BUILDS: release CI (desktop-release / engine-build) and
 * the local build scripts set DSHD_ENABLE_REMOTE_ACCESS=on, so released
 * closures carry this pass — fetch-dsh.cjs applies it ONLY when the value is
 * exactly 'on'; unset/off builds are upstream-pure dev closures (never ship
 * those).
 */

const fs = require('fs');
const path = require('path');

const MARKER = 'data-dsh-desktop-context="shim"';

const SHIM_BLOCK =
  `<script ${MARKER}>
      // dsh-desktop (LAN/Tailscale serving): plain HTTP on a LAN/Tailscale IP
      // is not a browser secure context, where crypto.randomUUID does not
      // exist at all; the web UI's RPC and message layers call it for ids, so
      // settings, provider catalogs and agent presets die with "crypto.randomUUID
      // is not a function". Shim an RFC 4122 v4 UUID from crypto.getRandomValues
      // (available in every context). Native wins where it exists (localhost /
      // HTTPS — secure contexts), so this is a no-op there.
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
        crypto.randomUUID = () => {
          const b = crypto.getRandomValues(new Uint8Array(16));
          b[6] = (b[6] & 0x0f) | 0x40; // version 4
          b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
          const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
          return \`\${h.slice(0, 8)}-\${h.slice(8, 12)}-\${h.slice(12, 16)}-\${h.slice(16, 20)}-\${h.slice(20)}\`;
        };
      }
    </script>\n`;

/**
 * Patch one index.html file in place (idempotent).
 * @param {string} target - absolute html path.
 * @returns {boolean} true when patched, false when already patched / no anchor.
 */
function patchWebUiFile(target) {
  let html;
  try {
    html = fs.readFileSync(target, 'utf8');
  } catch (error) {
    console.warn(`[patch-webui-index] skip (unreadable): ${target} — ${error.message}`);
    return false;
  }
  if (html.includes(MARKER)) {
    console.log(`[patch-webui-index] already patched: ${target}`);
    return false;
  }
  const anchor = html.includes('DeepSeek Harness</title>')
    ? 'DeepSeek Harness</title>'
    : html.includes('DSH Local Build</title>')
      ? 'DSH Local Build</title>'
      : undefined;
  if (anchor === undefined) {
    console.warn(`[patch-webui-index] skip (no title anchor): ${target}`);
    return false;
  }
  fs.writeFileSync(target, html.replace(anchor, `${anchor}\n${SHIM_BLOCK}`), 'utf8');
  console.log(`[patch-webui-index] patched: ${target}`);
  return true;
}

/**
 * Patch the dsh closure's web UI index files (built dist + vite source).
 * @param {string} dshDir - dsh root (`.dsh-build/dist` or a dsh release tree).
 * @returns {number} count of patched files.
 */
function patchWebUiIndex(dshDir) {
  let patched = 0;
  const targets = [
    // built dist — what dsh web actually serves
    path.join(dshDir, 'apps', 'web', 'dist', 'index.html'),
    // vite source template — keeps the shim through future rebuilds / dev
    path.join(dshDir, 'apps', 'web', 'index.html'),
  ];
  for (const target of targets) {
    if (patchWebUiFile(target)) patched += 1;
  }
  return patched;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg !== undefined && arg.endsWith('.html')) {
    patchWebUiFile(path.resolve(arg));
  } else {
    const root = arg !== undefined ? path.resolve(arg) : path.resolve(__dirname, '..', '.dsh-build', 'dist');
    patchWebUiIndex(root);
  }
}

module.exports = { patchWebUiIndex, patchWebUiFile };
