// Tests for the plugin-fences remote-access patch pass
// (desktop/scripts/patch-plugin-fences.cjs).
//
// The pass ships in DESKTOP BUILDS only (DSHD_ENABLE_REMOTE_ACCESS=on): it
// (1) publishes the deployment's resolved trustedHosts to the plugin process
// env (DSH_PLUGIN_MANAGER_TRUSTED_HOSTS + DSH_TRUSTED_HOSTS) so plugin-owned
// request fences accept LAN/Tailscale origins, and (2) relaxes the
// loopback-authority connection fences to admit declared trustedHosts.
// These tests cover the transform mechanics (src + built-bundle forms,
// idempotency, shape drift tolerance) and the runtime contract: the exact
// fence logic dsh-web-plugin-manager ships (extraTrustedHosts + isTrustedRequest
// copied verbatim from its dist) must pass LAN/Tailscale Hosts once the env is
// published, and keep rejecting foreign hosts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// CJS require of the patch script from the vitest ESM context.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { patchPluginFences, patchPluginFenceFile } = require(
  '../../scripts/patch-plugin-fences.cjs',
);

// ---------------------------------------------------------------------------
// Fixtures: the exact pre-patch shapes the pass anchors to (src form from
// packages/client/connection/src/{index,rpc-host}.ts; bundle form from the
// tsdown lib/index.js), trimmed to the fence-relevant regions.
// ---------------------------------------------------------------------------

const SRC_INDEX = `/** Host HTTP bridge for browser-client RPC. */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  const connection = new HostConnectionService(ctx, trustedHosts)
}
`;

const SRC_RPC_HOST = `  createSharedFetchHandler(channel, fallback) {\n` +
  `    return { fetch: (request) => {\n` +
  `      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)\n` +
  `      const interceptor = this.interceptors.get(channel)\n` +
  `      if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {\n` +
  `        return fallback.fetch(request)\n` +
  `      }\n` +
  `      if (interceptor.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {\n` +
  `        return Promise.resolve(new Response('forbidden', { status: 403 }))\n` +
  `      }\n` +
  `      return interceptor.fetchHandler.fetch(request)\n` +
  `    }\n` +
  `  }\n` +
  `}\n\n` +
  `    const trustedHosts = options.authority === 'loopback' ? [] : this.trustedHosts\n`;

const LIB_INDEX = `function apply(ctx, config) {\n` +
  `\tconst trustedHosts = config?.trustedHosts ?? [];\n` +
  `\tfor (const entry of trustedHosts) assertTrustedAuthority(entry);\n` +
  `\tconst connection = new HostConnectionService(ctx, trustedHosts);\n` +
  `}\n`;

const LIB_RPC_HOST = `	createSharedFetchHandler(channel, fallback) {\n` +
  `		return { fetch: (request) => {\n` +
  `			const endpoint = endpointFromPath(channel, new URL(request.url).pathname);\n` +
  `			if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, [])) return Promise.resolve(new Response("forbidden", { status: 403 }));\n` +
  `			return interceptor.fetchHandler.fetch(request);\n` +
  `		} };\n` +
  `	}\n` +
  `	register(owner, channel, handler, options) {\n` +
  `		assertChannel(channel);\n` +
  `		const trustedHosts = options.authority === "loopback" ? [] : this.trustedHosts;\n` +
  `	}\n`;

// ---------------------------------------------------------------------------
// dsh-web-plugin-manager fence contract: copied verbatim from the installed
// plugin dist (v0.x, src/index.js) — LOOPBACK_HOSTS, extraTrustedHosts,
// hostnameOf, portOf, isTrustedRequest. Kept as a regression fixture for the
// env-var contract; update when the plugin changes its fence shape.
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
function extraTrustedHosts() {
  const raw = process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS ?? '';
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));
}
function hostnameOf(authority: string): string {
  const s = authority.trim().toLowerCase();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end >= 0 ? s.slice(0, end + 1) : s;
  }
  const colon = s.lastIndexOf(':');
  return colon >= 0 ? s.slice(0, colon) : s;
}
function portOf(authority: string): string {
  const s = authority.trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end >= 0 && s.length > end + 1 && s[end + 1] === ':' ? s.slice(end + 2) : '';
  }
  const colon = s.lastIndexOf(':');
  return colon >= 0 ? s.slice(colon + 1) : '';
}
function isTrustedRequest(req: { headers?: Record<string, string | undefined> }): boolean {
  const rawHost = String(req.headers?.['host'] ?? '');
  if (rawHost.length === 0) return false;
  const host = hostnameOf(rawHost);
  if (!LOOPBACK_HOSTS.has(host) && !extraTrustedHosts().has(host)) return false;
  const secFetch = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (secFetch === 'cross-site') return false;
  const origin = String(req.headers?.['origin'] ?? '');
  if (origin.length === 0) return true;
  try {
    const url = new URL(origin);
    const originPort = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
    const reqPort = portOf(rawHost) === '' ? '80' : portOf(rawHost);
    return url.hostname.toLowerCase() === host && originPort === reqPort;
  } catch {
    return false;
  }
}

/** Value client-connection's patched apply() would export for a trust list. */
function publishedEnv(trustedHosts: string[]): string {
  return trustedHosts
    .map((entry) => {
      try {
        return new URL(`http://${entry}`).hostname;
      } catch {
        return undefined;
      }
    })
    .filter((hostname): hostname is string => hostname !== undefined)
    .join(',');
}

// ---------------------------------------------------------------------------

let dir: string;
let srcIndex: string;
let srcRpcHost: string;
let libIndex: string;
let libRpcHost: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-plugin-fences-'));
  const srcDir = join(dir, 'packages', 'client', 'connection', 'src');
  const libDir = join(dir, 'packages', 'client', 'connection', 'lib');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  srcIndex = join(srcDir, 'index.ts');
  srcRpcHost = join(srcDir, 'rpc-host.ts');
  libIndex = join(libDir, 'index.js');
  libRpcHost = join(libDir, 'index.js');
  writeFileSync(srcIndex, SRC_INDEX);
  writeFileSync(srcRpcHost, SRC_RPC_HOST);
  writeFileSync(libIndex, `${LIB_INDEX}\n${LIB_RPC_HOST}`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('patch-plugin-fences transforms', () => {
  it('patches src index (publish) and src rpc-host (both relaxes)', () => {
    expect(patchPluginFenceFile(srcIndex)).toBe(true);
    expect(patchPluginFenceFile(srcRpcHost)).toBe(true);
    let text = readFileSync(srcIndex, 'utf8');
    // Publish block anchored right after the authority assert.
    expect(text).toContain('DSH_PLUGIN_MANAGER_TRUSTED_HOSTS');
    expect(text).toContain('DSH_TRUSTED_HOSTS');
    expect(text.indexOf('for (const entry of trustedHosts) assertTrustedAuthority(entry)'))
      .toBeLessThan(text.indexOf('const pluginTrustHostnames'));
    text = readFileSync(srcRpcHost, 'utf8');
    expect(text).toContain("interceptor.options.authority === 'loopback' && "
      + '!isTrustedApiRequest(request, this.trustedHosts.length === 0 ? [] : this.trustedHosts)');
    expect(text).toContain("options.authority === 'loopback'"
      + ' && this.trustedHosts.length === 0 ? [] : this.trustedHosts');
  });

  it('patches the built bundle (publish + both relaxes, double quotes)', () => {
    expect(patchPluginFenceFile(libRpcHost)).toBe(true);
    const text = readFileSync(libRpcHost, 'utf8');
    expect(text).toContain('DSH_PLUGIN_MANAGER_TRUSTED_HOSTS');
    expect(text).toContain('"loopback" && this.trustedHosts.length === 0 ? [] : this.trustedHosts');
    expect(text).toContain('isTrustedApiRequest(request, this.trustedHosts.length === 0 ? [] : this.trustedHosts)');
  });

  it('walks the same closure tree and patch counts reflect it', () => {
    // Fresh tree: patchPluginFences(path) must patch all three targets once.
    const tree = mkdtempSync(join(tmpdir(), 'patch-plugin-fences-tree-'));
    try {
      mkdirSync(join(tree, 'packages', 'client', 'connection', 'src'), { recursive: true });
      mkdirSync(join(tree, 'packages', 'client', 'connection', 'lib'), { recursive: true });
      writeFileSync(join(tree, 'packages', 'client', 'connection', 'src', 'index.ts'), SRC_INDEX);
      writeFileSync(join(tree, 'packages', 'client', 'connection', 'src', 'rpc-host.ts'), SRC_RPC_HOST);
      writeFileSync(join(tree, 'packages', 'client', 'connection', 'lib', 'index.js'), `${LIB_INDEX}\n${LIB_RPC_HOST}`);
      expect(patchPluginFences(tree)).toBe(3);
      expect(patchPluginFences(tree)).toBe(0); // idempotent at the tree level too
      expect(readFileSync(join(tree, 'packages', 'client', 'connection', 'src', 'index.ts'), 'utf8'))
        .toContain('DSH_TRUSTED_HOSTS');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second run returns false and changes nothing', () => {
    for (const target of [srcIndex, srcRpcHost, libRpcHost]) {
      const before = readFileSync(target, 'utf8');
      expect(patchPluginFenceFile(target)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe(before);
    }
  });

  it('tolerates a drifted shape (missing anchors are skipped, not fatal)', () => {
    const drifted = join(dir, 'drifted.ts');
    writeFileSync(drifted, 'const x = 1\n');
    expect(patchPluginFenceFile(drifted)).toBe(false);
    expect(readFileSync(drifted, 'utf8')).toBe('const x = 1\n');
  });
});

describe('publish contract vs the plugin fence (regression)', () => {
  // A LAN deployment's connection.trustedHosts: auto-derived LAN/Tailscale IP
  // literals (webRuntime) + the profile's MagicDNS name (cordis.patch.yml).
  const deploymentHosts = ['198.18.0.1', '100.64.0.12', 'desktop-141inli.taile940d7.ts.net'];
  const env = publishedEnv(deploymentHosts);

  it('publishes the hostname-only, comma-separated shape the fence expects', () => {
    expect(env).toBe('198.18.0.1,100.64.0.12,desktop-141inli.taile940d7.ts.net');
  });

  it('lets a LAN/Tailscale browser pass the plugin fence (the 403 regression)', () => {
    const previous = process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS;
    process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = env;
    try {
      for (const host of ['198.18.0.1:3080', '100.64.0.12:3080', 'desktop-141inli.taile940d7.ts.net:3080']) {
        expect(isTrustedRequest({
          headers: {
            host,
            origin: `http://${host}`,
            'sec-fetch-site': 'same-origin',
          },
        })).toBe(true);
      }
      // Loopback still passes.
      expect(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } })).toBe(true);
      // A foreign host is still refused — the fence stays a fence.
      expect(isTrustedRequest({ headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080' } }))
        .toBe(false);
    } finally {
      process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = previous;
    }
  });

  it('keeps the fence loopback-only when no trustedHosts are published', () => {
    const previous = process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS;
    delete process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS;
    try {
      expect(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } })).toBe(true);
      expect(isTrustedRequest({ headers: { host: '192.168.1.10:3080' } })).toBe(false);
    } finally {
      process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = previous;
    }
  });

  it('connects the published env to the patch anchor (contract guard)', () => {
    // Guard: the env name published by the patched closure is exactly the name
    // the fence reads — if either side drifts the regression above silently
    // tests the wrong thing.
    const patched = readFileSync(srcIndex, 'utf8');
    expect(patched).toContain("process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = pluginTrustHostnames");
  });
});
