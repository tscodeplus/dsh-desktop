// Pre-flight migration for the dsh profile patch layer
// (`<home>/profiles/web/cordis.patch.yml`).
//
// Upstream 0.2.x turned the shipped agent presets into dsh-web-app patch
// layers whose 创造模式 (cordis) / standard / ptc presets enable
// `tool-plugin-manager` (`@deepseek-ai/dsh-plugin-manager/tools`) whenever a
// profileContext exists; that tool resolves the host `pluginManager` service
// (dsh-base enables it under the same condition). A user patch layer that
// still carries a stale `- id: plugin-manager / disabled: true` row (left by
// an earlier plugin-management arrangement) is applied LAST and wins per id,
// so the service never mounts and the preset row reports forever:
//   "tool-plugin-manager (@deepseek-ai/dsh-plugin-manager/tools):
//    waiting for pluginManager"
// — the preset mount audit in @deepseek-ai/dsh-agent-preset-registry rejects
// pending rows, so Settings > Agent presets shows the preset as failed.
//
// The engine channel swaps closures under ~/.dsh/engine but never touches
// user data, so the desktop must reconcile the stale row itself: before every
// dsh spawn, when the closure actually being spawned is 0.2.x+, remove the
// known-stale disable row (id plugin-manager, literal disabled: true, no name
// override or the upstream module name). Everything else in the file — user
// settings rows, LAN/Tailscale webserver/connection config, `!!js`
// expressions, comments — is preserved byte-for-byte by the CST round-trip
// (same comment-preserving parseDocument technique upstream's own
// plugin-manager patch.ts uses for enablement edits).
//
// Non-fatal by design: any failure to read/parse/write logs and leaves the
// file untouched; dsh still spawns (the patch stays upstream-pure until the
// user fixes it by hand).

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isMap, parseDocument } from 'yaml';

import { compareVersions } from './updater.js';

/** Profile the sidecar's `dsh web` spawn targets. */
export const PROFILE_NAME = 'web';
/** Entry id and owning module of the upstream plugin-manager service row. */
export const PLUGIN_MANAGER_ID = 'plugin-manager';
export const PLUGIN_MANAGER_NAME = '@deepseek-ai/dsh-plugin-manager';
/** First upstream version whose presets depend on the service being mounted. */
export const MIN_MIGRATE_VERSION = '0.2.0';

export interface PatchMigration {
  changed: boolean;
  /** New file text (identical to the input when unchanged). */
  text: string;
  /** Entry ids removed from the patch. */
  removedIds: string[];
}

/**
 * Pure core: remove stale `plugin-manager` disable rows from one patch text.
 * Malformed YAML (or no YAML sequence at top level) is passed through
 * unchanged — never a destructive rewrite of a file we cannot parse.
 * @param patchText - current cordis.patch.yml content.
 * @returns MigrationResult with changed=true when a row was removed.
 */
export function removeStalePluginManagerDisable(patchText: string): PatchMigration {
  const noChange: PatchMigration = { changed: false, text: patchText, removedIds: [] };
  const document = parseDocument(patchText, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  });
  if (document.errors.length > 0) return noChange;
  const contents = document.contents as { items?: unknown[] } | null;
  if (!contents || !Array.isArray(contents.items)) return noChange;

  const removedIds: string[] = [];
  // Removal loop (not a plain filter) so a removed item's head comments
  // (e.g. the managed-region markers) survive on the next kept item instead
  // of vanishing with the CST node.
  const items = contents.items as Array<Record<string, unknown>>;
  const kept: Array<Record<string, unknown>> = [];
  let carriedComment: string | null = null;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let stale = false;
    if (isMap(item as never) && document.getIn([index, 'id']) === PLUGIN_MANAGER_ID) {
      // A name-qualified override for another module is not the upstream row.
      const name = document.getIn([index, 'name']);
      const nameOk = typeof name !== 'string' || name === PLUGIN_MANAGER_NAME;
      if (nameOk && document.getIn([index, 'disabled']) === true) stale = true;
    }
    if (stale) {
      removedIds.push(PLUGIN_MANAGER_ID);
      const commentBefore = (item as { commentBefore?: string }).commentBefore;
      if (typeof commentBefore === 'string' && commentBefore !== '') {
        carriedComment = (carriedComment ?? '') + commentBefore;
      }
      continue;
    }
    if (carriedComment !== null) {
      item.commentBefore = carriedComment + ((item.commentBefore as string | undefined) ?? '');
      carriedComment = null;
    }
    kept.push(item);
  }
  // A removal at the very end has no following item to carry the comment;
  // re-attach it as a trailing comment on the last kept item so no text is
  // silently dropped. No kept items at all → the original text stands.
  if (carriedComment !== null && kept.length > 0) {
    const last = kept[kept.length - 1];
    last.comment = ((last.comment as string | undefined) ?? '') + carriedComment;
  }
  if (removedIds.length === 0) return noChange;
  contents.items = kept;
  return { changed: true, text: String(document), removedIds };
}

/** Outcome of the file-level migration (null = nothing to do / no engine ref). */
export interface ProfilePatchMigrationOutcome {
  changed: boolean;
  removedIds: string[];
  /** Backup path when the file was rewritten. */
  backupPath?: string;
}

/**
 * File-level wrapper: version-gate on the closure actually being spawned,
 * then rewrite `profiles/<web>/cordis.patch.yml` when the stale row exists.
 * Atomic write (tmp + rename) with a timestamped `.pre-migration-<ts>`
 * backup beside the original.
 * @param dshHome - DSH_HOME (user data root, e.g. ~/.dsh).
 * @param dshRoot - the dsh closure dsh will spawn from (carries .engine-ref.json).
 * @returns Outcome, or null when no engine ref / patch file / no change.
 */
export function migrateStalePluginManagerDisable(
  dshHome: string,
  dshRoot: string,
): ProfilePatchMigrationOutcome | null {
  // Version gate: only closures whose base composition expects the service
  // mounted (0.2.x+) justify touching the user layer. Unknown ref → no-op.
  let engineVersion: string | undefined;
  try {
    engineVersion = JSON.parse(readFileSync(join(dshRoot, '.engine-ref.json'), 'utf8'))
      ?.upstreamVersion;
  } catch {
    return null;
  }
  if (typeof engineVersion !== 'string' || engineVersion === '') return null;
  if (compareVersions(engineVersion, MIN_MIGRATE_VERSION) < 0) return null;

  const patchFile = join(dshHome, 'profiles', PROFILE_NAME, 'cordis.patch.yml');
  let patchText: string;
  try {
    patchText = readFileSync(patchFile, 'utf8');
  } catch {
    return null;
  }
  const migration = removeStalePluginManagerDisable(patchText);
  if (!migration.changed) return null;

  const backupPath = `${patchFile}.pre-migration-${Date.now()}`;
  copyFileSync(patchFile, backupPath);
  mkdirSync(dirname(patchFile), { recursive: true });
  const tmpFile = `${patchFile}.tmp`;
  writeFileSync(tmpFile, migration.text, 'utf8');
  renameSync(tmpFile, patchFile);
  return { changed: true, removedIds: migration.removedIds, backupPath };
}
