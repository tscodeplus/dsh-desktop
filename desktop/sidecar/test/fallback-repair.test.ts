import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repairProfilesModuleFallback } from '../src/fallback-repair.js';

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fallback-test-'));
  homes.push(dir);
  return dir;
}

function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('repairProfilesModuleFallback', () => {
  it('removes empty real dirs and keeps symlinks, files, and non-empty dirs', () => {
    const home = tempHome();
    const nm = join(home, 'profiles', 'node_modules');
    const target = join(home, 'target');
    mkdirSync(target, { recursive: true });
    mkdirSync(nm, { recursive: true });

    // Symlinks (a healthy flat link and a healthy scoped link) must survive.
    link(target, join(nm, 'flat-link'));
    const scope = join(nm, '@scope');
    mkdirSync(scope, { recursive: true });
    const scopedLink = join(scope, 'ok');
    mkdirSync(join(target, 'ok'), { recursive: true });
    link(join(target, 'ok'), scopedLink);

    // Empty real dirs — leftovers of an interrupted link creation.
    const flatLeftover = join(nm, 'flat-leftover');
    mkdirSync(flatLeftover);
    const scopedLeftover = join(scope, 'leftover');
    mkdirSync(scopedLeftover);
    // A scope dir whose only entry is an empty leftover must be removed too.
    const ghostScope = join(nm, '@ghost');
    mkdirSync(join(ghostScope, 'leftover'), { recursive: true });

    // Non-empty real dir: user content — never removed.
    const filled = join(scope, 'filled');
    mkdirSync(filled);
    writeFileSync(join(filled, 'package.json'), '{}\n');
    // A real file: never removed.
    writeFileSync(join(nm, 'file-leftover'), '');

    const removed = repairProfilesModuleFallback(home);

    expect(removed).toContain(flatLeftover);
    expect(removed).toContain(scopedLeftover);
    expect(removed).toContain(ghostScope);
    expect(removed).not.toContain(join(nm, 'file-leftover'));
    expect(removed).not.toContain(scope);
    expect(removed).not.toContain(filled);
    expect(removed).not.toContain(join(nm, 'flat-link'));

    expect(existsSync(flatLeftover)).toBe(false);
    expect(existsSync(scopedLeftover)).toBe(false);
    expect(existsSync(ghostScope)).toBe(false);
    expect(lstatSync(join(nm, 'flat-link')).isSymbolicLink()).toBe(true);
    expect(lstatSync(scopedLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(scope, 'filled', 'package.json'))).toBe(true);
  });

  it('returns [] when the fallback dir does not exist', () => {
    expect(repairProfilesModuleFallback(tempHome())).toEqual([]);
  });
});
