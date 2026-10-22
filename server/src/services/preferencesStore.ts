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

export interface PraxisProject {
  path: string;
  name: string;
  isDefault: boolean;
  prompt?: string;
}

export type PreferencesRecord = Record<string, unknown>;

export async function readPreferences(prefsPath: string = PREFS_PATH): Promise<PreferencesRecord> {
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writePreferences(prefs: PreferencesRecord, prefsPath: string = PREFS_PATH): Promise<void> {
  await fs.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.writeFile(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
}

/// Accepts anything and returns a clean PraxisProject[] (drops malformed entries,
/// trims strings, dedupes by resolved path, guarantees at most one isDefault).
export function sanitizePraxisProjects(input: unknown): PraxisProject[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: PraxisProject[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawPath = typeof rec.path === 'string' ? rec.path.trim() : '';
    if (!rawPath) continue;
    const key = path.resolve(rawPath).toLowerCase(); // case-insensitive dedupe is fine on both OSes for our purpose
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : path.basename(path.resolve(rawPath)) || rawPath;
    const prompt = typeof rec.prompt === 'string' && rec.prompt.trim() ? rec.prompt : undefined;
    out.push({ path: rawPath, name, isDefault: rec.isDefault === true, ...(prompt !== undefined ? { prompt } : {}) });
  }
  let defaultSeen = false;
  for (const p of out) {
    if (p.isDefault) {
      if (defaultSeen) p.isDefault = false;
      defaultSeen = true;
    }
  }
  return out;
}

/// AUG-142: the single legacy `praxisProjectPath` becomes the first registered project.
/// Pure. Returns the same object (===) when nothing changed so callers can skip the write.
export function migratePraxisProjects(prefs: PreferencesRecord): PreferencesRecord {
  const legacy = typeof prefs.praxisProjectPath === 'string' ? prefs.praxisProjectPath.trim() : '';
  const projects = sanitizePraxisProjects(prefs.praxisProjects);
  if (!legacy) return prefs;
  const { praxisProjectPath: _dropped, ...rest } = prefs;
  const alreadyThere = projects.some((p) => path.resolve(p.path).toLowerCase() === path.resolve(legacy).toLowerCase());
  if (alreadyThere) return { ...rest, praxisProjects: projects };
  const migrated: PraxisProject = {
    path: legacy,
    name: path.basename(path.resolve(legacy)) || legacy,
    isDefault: !projects.some((p) => p.isDefault),
  };
  return { ...rest, praxisProjects: [...projects, migrated] };
}

/// Reads prefs and persists the legacy->projects migration once. Safe to call on every request.
export async function readPreferencesMigrated(prefsPath: string = PREFS_PATH): Promise<PreferencesRecord> {
  const prefs = await readPreferences(prefsPath);
  const migrated = migratePraxisProjects(prefs);
  if (migrated !== prefs) await writePreferences(migrated, prefsPath);
  return migrated;
}
