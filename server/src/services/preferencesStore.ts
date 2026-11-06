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

export const PRAXIS_RECENT_LIMIT = 5;

/// AUG-192: recent unregistered Praxis folders. Strings only, trimmed, empty dropped, deduped by resolved
/// path case-insensitively (same rule as sanitizePraxisProjects), registered project paths dropped,
/// at most PRAXIS_RECENT_LIMIT, order kept (callers put the newest first). Paths are stored exactly as given.
export function sanitizePraxisRecentPaths(input: unknown, projects: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const key = (p: string) => path.resolve(p).toLowerCase();
  const seen = new Set(sanitizePraxisProjects(projects).map((p) => key(p.path)));
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const k = key(trimmed);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
    if (out.length >= PRAXIS_RECENT_LIMIT) break;
  }
  return out;
}

/// Compact Mode prefs (AUG-156): booleans are strict, enums drop unknown values, the strip width clamps to 280–520
/// and the Ghost Caption height to 72–480 and width to 320–760. AUG-188: the Ghost Caption font size and background
/// opacity snap to the nearest step (12/14/16/18/22 px, 40/60/78/90/100 %).
export function sanitizeCompactPreferences(patch: PreferencesRecord): PreferencesRecord {
  const out: PreferencesRecord = { ...patch };
  for (const key of ['compactEnabled', 'compactAlwaysOnTop', 'compactHintSeen']) {
    if (key in out) out[key] = out[key] === true;
  }
  const enums: Record<string, readonly string[]> = {
    compactMode: ['follow', 'indicator', 'transcript'],
    compactIndicatorWidget: ['dock-square', 'ghost-coin'],
    compactTranscriptWidget: ['dock-strip', 'ghost-caption'],
    compactExpandOn: ['stop', 'click'],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (key in out && !(typeof out[key] === 'string' && allowed.includes(out[key] as string))) delete out[key];
  }
  if ('compactStripWidth' in out) {
    const n = Number(out.compactStripWidth);
    if (Number.isFinite(n)) out.compactStripWidth = Math.min(520, Math.max(280, Math.round(n)));
    else delete out.compactStripWidth;
  }
  if ('compactCaptionHeight' in out) {
    const n = Number(out.compactCaptionHeight);
    if (Number.isFinite(n)) out.compactCaptionHeight = Math.min(480, Math.max(72, Math.round(n)));
    else delete out.compactCaptionHeight;
  }
  if ('compactCaptionWidth' in out) {
    const n = Number(out.compactCaptionWidth);
    if (Number.isFinite(n)) out.compactCaptionWidth = Math.min(760, Math.max(320, Math.round(n)));
    else delete out.compactCaptionWidth;
  }
  const steps: Record<string, readonly number[]> = {
    compactCaptionFontSize: [12, 14, 16, 18, 22],
    compactCaptionOpacity: [40, 60, 78, 90, 100],
  };
  for (const [key, list] of Object.entries(steps)) {
    if (!(key in out)) continue;
    const n = Number(out[key]);
    if (Number.isFinite(n)) out[key] = list.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), list[0]);
    else delete out[key];
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

/// AUG-198: AI assistants (Meeting Copilot + Active session). Spec docs/mockups/AUG-194/findings.md §3.1.
export const AI_MODELS = ['haiku', 'sonnet', 'opus'] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const AI_TRANSCRIPT_WINDOWS = [2, 5, 10, 15] as const;
export const AI_BUDGET_MAX_USD = 1000;
export const AI_DEFAULTS = { model: 'sonnet' as AiModel, budgetUsd: 2, transcriptWindowMin: 5 };

/// USD spending limit: Number(); empty string, non-number types, non-finite or negative → null (caller drops the key);
/// rounded to cents, capped at AI_BUDGET_MAX_USD. 0 = no limit.
export function sanitizeBudgetUsd(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(AI_BUDGET_MAX_USD, Math.round(n * 100) / 100);
}

export function sanitizeAiModel(value: unknown): AiModel | null {
  return typeof value === 'string' && (AI_MODELS as readonly string[]).includes(value) ? (value as AiModel) : null;
}

/// Snaps to the nearest of 2/5/10/15 (ties go to the smaller); non-finite → null.
export function sanitizeTranscriptWindow(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return AI_TRANSCRIPT_WINDOWS.reduce<number>((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), AI_TRANSCRIPT_WINDOWS[0]);
}

/// Same shape as sanitizeCompactPreferences: invalid values drop the key from the patch. The server-only keys
/// (aiCopilotMode, aiCopilotConsent, aiCopilotAlwaysAck, aiSessionEnabled, aiConsent) are not in ALLOWED_KEYS and never reach here.
export function sanitizeAssistantPreferences(patch: PreferencesRecord): PreferencesRecord {
  const out: PreferencesRecord = { ...patch };
  for (const key of ['aiCopilotModel', 'aiModel']) {
    if (!(key in out)) continue;
    const v = sanitizeAiModel(out[key]);
    if (v === null) delete out[key]; else out[key] = v;
  }
  for (const key of ['aiCopilotAlwaysBudgetUsd', 'aiSessionBudgetUsd']) {
    if (!(key in out)) continue;
    const v = sanitizeBudgetUsd(out[key]);
    if (v === null) delete out[key]; else out[key] = v;
  }
  if ('aiTranscriptWindowMin' in out) {
    const v = sanitizeTranscriptWindow(out.aiTranscriptWindowMin);
    if (v === null) delete out.aiTranscriptWindowMin; else out.aiTranscriptWindowMin = v;
  }
  return out;
}
