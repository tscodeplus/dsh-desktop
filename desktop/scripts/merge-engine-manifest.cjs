#!/usr/bin/env node
/**
 * merge-engine-manifest.cjs — merge per-platform fragments (written by
 * package-engine.cjs) into the single engine-manifest.json the desktop app
 * fetches from the `engine` release.
 *
 * Also prints the set of asset file names the manifest references, so the
 * publish step (CI or manual) can delete stale assets from the fixed
 * `engine` release (ref changes the file name; old files would pile up).
 *
 * Usage: node scripts/merge-engine-manifest.cjs
 *   (reads desktop/engine-fragment-*.json, writes desktop/engine-manifest.json)
 */

const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const FRAGMENTS = fs
  .readdirSync(DESKTOP)
  .filter((f) => /^engine-fragment-.*\.json$/.test(f))
  .sort();
const OUT = path.join(DESKTOP, 'engine-manifest.json');
const BASE_URL =
  'https://github.com/tscodeplus/dsh-desktop/releases/download/engine';

if (FRAGMENTS.length === 0) {
  console.error('[merge-engine-manifest] no engine-fragment-*.json found — run package-engine.cjs first');
  process.exit(1);
}

const platforms = {};
const assetNames = new Set();
for (const f of FRAGMENTS) {
  const frag = JSON.parse(fs.readFileSync(path.join(DESKTOP, f), 'utf8'));
  if (typeof frag.platform !== 'string' || typeof frag.file !== 'string') {
    console.error(`[merge-engine-manifest] bad fragment ${f}: missing platform/file`);
    process.exit(1);
  }
  // URL is derivable — the download URL pattern is fixed by the release tag.
  platforms[frag.platform] = {
    ref: frag.ref,
    tag: frag.tag,
    version: frag.version,
    file: frag.file,
    url: `${BASE_URL}/${frag.file}`,
    sha512: frag.sha512,
    size: frag.size,
    builtAt: frag.builtAt,
  };
  assetNames.add(frag.file);
}

const manifest = {
  tag: 'engine',
  updatedAt: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[merge-engine-manifest] wrote ${OUT} (platforms: ${FRAGMENTS.join(', ')})`);
console.log(`[merge-engine-manifest] assets to publish:`);
for (const name of assetNames) console.log(`  ${name}`);
console.log(`[merge-engine-manifest] assets to clean (any other dsh-engine-*.tar.gz on the release):`);
console.log('  (delete with: gh release delete-asset engine <name> --yes)');
