import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-config-test-'));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  delete process.env.DSHD_HOME;
});

describe('config', () => {
  it('returns defaults when no file exists', () => {
    process.env.DSHD_HOME = tempHome();
    expect(loadConfig()).toEqual({
      closeToTray: true,
      autoStart: false,
      theme: 'system',
      bindAdapter: 'lan',
      firstRunDone: false,
    });
  });

  it('sanitizes an unknown bindAdapter value back to lan', () => {
    const home = tempHome();
    process.env.DSHD_HOME = home;
    writeFileSync(
      join(home, 'desktop-config.json'),
      JSON.stringify({ bindAdapter: 'wifi' }),
      'utf8',
    );
    expect(loadConfig().bindAdapter).toBe('lan');
  });

  it('preserves a tailscale bindAdapter', () => {
    const home = tempHome();
    process.env.DSHD_HOME = home;
    writeFileSync(
      join(home, 'desktop-config.json'),
      JSON.stringify({ bindAdapter: 'tailscale' }),
      'utf8',
    );
    expect(loadConfig().bindAdapter).toBe('tailscale');
  });

  it('round-trips a saved config', () => {
    process.env.DSHD_HOME = tempHome();
    const cfg = {
      closeToTray: false,
      autoStart: true,
      theme: 'dark' as const,
      language: 'zh-CN' as const,
      bindAdapter: 'tailscale' as const,
      firstRunDone: true,
    };
    saveConfig(cfg);
    expect(loadConfig()).toEqual(cfg);
  });

  it('merges partial config over defaults', () => {
    const home = tempHome();
    process.env.DSHD_HOME = home;
    writeFileSync(join(home, 'desktop-config.json'), JSON.stringify({ theme: 'light' }), 'utf8');
    const cfg = loadConfig();
    expect(cfg.theme).toBe('light');
    expect(cfg.closeToTray).toBe(true);
  });

  it('falls back to defaults on corrupt JSON', () => {
    const home = tempHome();
    process.env.DSHD_HOME = home;
    writeFileSync(join(home, 'desktop-config.json'), '{not json', 'utf8');
    expect(loadConfig().theme).toBe('system');
  });
});
