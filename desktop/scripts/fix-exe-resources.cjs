// Post-build fixup: make sure the Windows exe carries the app icon, version
// strings and the comctl32 v6 manifest in its .rsrc section.
//
// Why this exists: inside some environments (observed with rustc 1.98.1 +
// tauri-build 2.6.3 on this build host) the tauri-build build script stops
// mid-run during the resource copy step with a silent exit-0 — tauri-winres
// never emits the `cargo:rustc-link-arg-bins=` directive and the linked exe
// ships WITHOUT any .rsrc (no icon, no VERSIONINFO, no manifest). This script
// runs after cargo and patches the PE in place with rcedit / mt.exe.
//
// Safe to run on every build: it is idempotent. When the exe already has
// resources (normal CI / healthy toolchain), rcedit rewrites the same icon and
// version info and mt.exe replaces the manifest with byte-equivalent content.
//
// Usage: node scripts/fix-exe-resources.cjs <path-to-exe>

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error('[fix-exe-resources] usage: node scripts/fix-exe-resources.cjs <exe>');
  process.exit(1);
}

const desktopDir = path.join(__dirname, '..');
const iconsDir = path.join(desktopDir, 'src-tauri', 'icons');
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const version = pkg.version;

// rcedit ships a prebuilt Windows binary under node_modules/rcedit/bin
const rceditBin = path.join(desktopDir, 'node_modules', 'rcedit', 'bin',
  process.arch === 'x64' && os.arch() === 'x64' ? 'rcedit-x64.exe' : 'rcedit.exe');

const mtCandidates = [
  'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/mt.exe',
  'C:/Program Files (x86)/Windows Kits/10/bin/10.0.22621.0/x64/mt.exe',
  'C:/Program Files (x86)/Windows Kits/10/bin/10.0.20348.0/x64/mt.exe',
];
const mt = mtCandidates.find((p) => fs.existsSync(p)) || null;

const manifest = [
  '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">',
  '  <dependency>',
  '    <dependentAssembly>',
  '      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"',
  '        version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />',
  '    </dependentAssembly>',
  '  </dependency>',
  '</assembly>',
].join('\r\n');

function run(cmd, args, opts = {}) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  if (r.status !== 0) {
    const out = (r.stdout || '').toString().trim();
    const err = (r.stderr || '').toString().trim();
    throw new Error(`${path.basename(cmd)} exited ${r.status}\n${out}\n${err}`);
  }
}

async function main() {
  const { rcedit } = require('rcedit'); // calls bin/rcedit-*.exe via cross-spawn-windows-exe

  // 1) icon + version strings (idempotent writes)
  await rcedit(exe, {
    icon: path.join(iconsDir, 'icon.ico'),
    'version-string': {
      ProductName: 'DSH Desktop',
      FileDescription: 'DSH Desktop',
      CompanyName: 'dshd',
    },
    'file-version': version,
    'product-version': version,
  });
  console.log('[fix-exe-resources] icon + version strings patched');

  // 2) comctl32 v6 manifest (skip if mt.exe not found — rare)
  if (mt) {
    const manPath = `${os.tmpdir()}/dsh-desktop.manifest`;
    fs.writeFileSync(manPath, manifest);
    run(mt, ['-manifest', manPath, '-outputresource:' + exe + ';#1']);
    console.log('[fix-exe-resources] comctl32 manifest patched');
  } else {
    console.log('[fix-exe-resources] mt.exe not found — leaving manifest untouched');
  }

  console.log('[fix-exe-resources] done');
}

main().catch((e) => {
  console.error('[fix-exe-resources] FAILED\n' + e.message);
  process.exit(1);
});
