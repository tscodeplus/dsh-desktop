// Pre-flight repair for the dsh module fallback at `<home>/profiles/node_modules`.
//
// dsh-app-boot's healProfilesModuleFallback maintains one symlink per package
// of the app's dependency closure in that directory; since the rc2-era engine
// its ensureSymlink is STRICT: an entry that exists but is not a symlink makes
// `dsh web` throw and exit 1 before the server ever starts. An empty REAL dir
// is always a leftover of an interrupted link creation (a fresh-install's
// first boot killed mid-heal, AV interference, ...) — nothing in it, nothing
// lost by removing it, and dsh recreates the symlink on its next boot.
//
// Only EMPTY real dirs are removed: a non-empty real dir may hold user
// changes (e.g. a copy-fallback from an older engine), so it is left for dsh's
// own "exists and is not a symlink; remove it" error to surface to the user.

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Remove stale empty real dirs under the dsh module fallback.
 *
 * Walks `<home>/profiles/node_modules` flat entries and, for real `@scope`
 * dirs, their inner entries too; a real (non-symlink) directory that is empty
 * is deleted. Symlinks, files, and non-empty dirs are never touched. Scope
 * dirs emptied by the walk are removed as well (dsh re-creates them).
 *
 * @param home - the dsh home (defaults to `DSHD_HOME` / `~/.dsh` at call site).
 * @returns the removed paths, in removal order.
 */
export function repairProfilesModuleFallback(home: string): string[] {
  const modulesDir = join(home, 'profiles', 'node_modules');
  if (!existsSync(modulesDir)) return [];
  const removed: string[] = [];
  const removeIfEmptyRealDir = (path: string): void => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      if (readdirSync(path).length === 0) {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      }
    } catch {
      /* entry vanished mid-walk — nothing to do */
    }
  };
  let entries: string[];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith('@')) {
      removeIfEmptyRealDir(join(modulesDir, name));
      continue;
    }
    const scope = join(modulesDir, name);
    if (lstatSync(scope).isSymbolicLink()) continue;
    let inner: string[];
    try {
      inner = readdirSync(scope);
    } catch {
      continue;
    }
    for (const child of inner) removeIfEmptyRealDir(join(scope, child));
    // A scope dir whose entries were all empty leftovers is a leftover itself.
    removeIfEmptyRealDir(scope);
  }
  return removed;
}
