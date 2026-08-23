import { describe, expect, it } from 'vitest';
import {
  decideEngineUpdate,
  parseEngineManifest,
  readEngineRef,
} from '../src/engine-updater.js';
import type { EngineManifestEntry, EngineRef } from '../src/engine-updater.js';

const MANIFEST_TEXT = JSON.stringify({
  tag: 'engine',
  updatedAt: '2026-08-19T00:00:00.000Z',
  platforms: {
    'win32-x64': {
      ref: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
      tag: 'dsh-v0.1.0-rc.7',
      version: '0.1.0-rc.7',
      file: 'dsh-engine-win32-x64-99f6f02fecdb.tar.gz',
      url: 'https://github.com/tscodeplus/dsh-desktop/releases/download/engine/dsh-engine-win32-x64-99f6f02fecdb.tar.gz',
      sha512: 'c2hhNTEyLWZha2U=',
      size: 12345678,
    },
    'darwin-arm64': {
      ref: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
      tag: 'dsh-v0.1.0-rc.7',
      version: '0.1.0-rc.7',
      file: 'dsh-engine-darwin-arm64-99f6f02fecdb.tar.gz',
      url: 'https://github.com/tscodeplus/dsh-desktop/releases/download/engine/dsh-engine-darwin-arm64-99f6f02fecdb.tar.gz',
      sha512: 'c2hhNTEyLWZha2U=',
      size: 12345678,
    },
  },
});

const RC6_REF: EngineRef = {
  ref: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tag: 'dsh-v0.1.0-rc.6',
  upstreamVersion: '0.1.0-rc.6',
  platform: 'win32-x64',
};

const RC7_ENTRY: EngineManifestEntry = {
  ref: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
  tag: 'dsh-v0.1.0-rc.7',
  version: '0.1.0-rc.7',
  file: 'dsh-engine-win32-x64-99f6f02fecdb.tar.gz',
  url: 'https://github.com/tscodeplus/dsh-desktop/releases/download/engine/dsh-engine-win32-x64-99f6f02fecdb.tar.gz',
  sha512: 'c2hhNTEyLWZha2U=',
  size: 12345678,
};

describe('parseEngineManifest', () => {
  it('picks the entry for the requested platform', () => {
    const win = parseEngineManifest(MANIFEST_TEXT, 'win32-x64');
    expect(win?.version).toBe('0.1.0-rc.7');
    expect(win?.ref).toBe('99f6f02fecdb7dff40c3fbc9470f5907c29f74ca');
    const arm = parseEngineManifest(MANIFEST_TEXT, 'darwin-arm64');
    expect(arm?.file).toContain('darwin-arm64');
  });

  it('returns null for a missing platform', () => {
    expect(parseEngineManifest(MANIFEST_TEXT, 'linux-x64')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseEngineManifest('not json', 'win32-x64')).toBeNull();
    expect(parseEngineManifest('{"platforms": null}', 'win32-x64')).toBeNull();
    expect(parseEngineManifest('', 'win32-x64')).toBeNull();
  });
});

describe('decideEngineUpdate', () => {
  it('offers an update when the published version is newer (rc6 → rc7)', () => {
    expect(decideEngineUpdate(RC6_REF, RC7_ENTRY)).toEqual({ update: true });
  });

  it('does not offer an update for the same ref', () => {
    const same: EngineRef = { ...RC6_REF, ref: RC7_ENTRY.ref, upstreamVersion: RC7_ENTRY.version };
    expect(decideEngineUpdate(same, RC7_ENTRY)).toEqual({ update: false, reason: 'same ref' });
  });

  it('does not offer an update when the published version is not newer', () => {
    const newerLocal: EngineRef = {
      ref: 'ffffffffffffffffffffffffffffffffffffffff',
      tag: 'dsh-v0.2.0',
      upstreamVersion: '0.2.0',
      platform: 'win32-x64',
    };
    expect(decideEngineUpdate(newerLocal, RC7_ENTRY)).toEqual({
      update: false,
      reason: 'published version not newer',
    });
  });

  it('returns no update when there is no manifest entry (404 case)', () => {
    expect(decideEngineUpdate(RC6_REF, null)).toEqual({ update: false, reason: 'no manifest entry' });
  });

  it('offers an update when the local engine has no ref (seed missing)', () => {
    expect(decideEngineUpdate(null, RC7_ENTRY)).toEqual({ update: true });
  });

  it('falls back to ref difference when versions are unparseable', () => {
    const weird: EngineRef = { ref: 'aaa', tag: null, upstreamVersion: 'weird', platform: 'x' };
    expect(decideEngineUpdate(weird, RC7_ENTRY)).toEqual({ update: true });
  });
});

describe('readEngineRef', () => {
  it('reads .engine-ref.json from <dir>/dsh-dist', () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'engine-ref-'));
    try {
      mkdirSync(join(dir, 'dsh-dist'));
      writeFileSync(join(dir, 'dsh-dist', '.engine-ref.json'), JSON.stringify(RC6_REF), 'utf8');
      expect(readEngineRef(dir)).toEqual(RC6_REF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the closure has no provenance file', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'engine-ref-'));
    try {
      expect(readEngineRef(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for corrupt JSON', () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'engine-ref-'));
    try {
      mkdirSync(join(dir, 'dsh-dist'));
      writeFileSync(join(dir, 'dsh-dist', '.engine-ref.json'), '{broken', 'utf8');
      expect(readEngineRef(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
