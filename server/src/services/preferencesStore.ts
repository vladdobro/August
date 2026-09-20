import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/// Canonical runtime location: server/data/user-preferences.json (gitignored, next to sessions/uploads).
export const PREFS_PATH = path.join(config.dataDir, 'user-preferences.json');

/// Pre-AUG-109 location: server/src/data/user-preferences.json. It was tracked in git, so every
/// session dirtied the working tree. Kept only so old checkouts migrate automatically.
export const LEGACY_PREFS_PATH = path.resolve(config.dataDir, '..', 'src', 'data', 'user-preferences.json');

export type MigrationResult = 'migrated' | 'no-legacy-file' | 'target-already-exists';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/// Removes the legacy directory when it is empty; any other outcome is ignored.
async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch {
    // not empty or already gone — either is fine
  }
}

/// One-time move of the legacy preferences file into the canonical data dir.
/// Idempotent: a second run finds no legacy file and does nothing. Never overwrites an
/// existing target file — in that case the stale legacy copy is removed and the target kept.
export async function migrateLegacyPreferences(
  legacyPath: string = LEGACY_PREFS_PATH,
  targetPath: string = PREFS_PATH,
  log: (msg: string) => void = console.log,
): Promise<MigrationResult> {
  if (!(await exists(legacyPath))) {
    return 'no-legacy-file';
  }

  if (await exists(targetPath)) {
    await fs.unlink(legacyPath);
    await removeDirIfEmpty(path.dirname(legacyPath));
    log(`Preferences: kept ${targetPath}; removed stale legacy copy at ${legacyPath}`);
    return 'target-already-exists';
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  // COPYFILE_EXCL guarantees we never clobber a target that appeared between the check and the copy.
  await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
  await fs.unlink(legacyPath);
  await removeDirIfEmpty(path.dirname(legacyPath));
  log(`Preferences: migrated ${legacyPath} -> ${targetPath}`);
  return 'migrated';
}
