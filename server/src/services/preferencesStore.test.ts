import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyPreferences, migratePraxisProjects, sanitizePraxisProjects, sanitizeCompactPreferences } from './preferencesStore.js';

let root: string;
let legacyPath: string;
let targetPath: string;
const logs: string[] = [];
const log = (msg: string) => {
  logs.push(msg);
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'august-prefs-'));
  legacyPath = path.join(root, 'src', 'data', 'user-preferences.json');
  targetPath = path.join(root, 'data', 'user-preferences.json');
  logs.length = 0;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('migrateLegacyPreferences', () => {
  test('moves legacy file to target when target is missing and logs it', async () => {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{"language":"ru"}', 'utf-8');

    const result = await migrateLegacyPreferences(legacyPath, targetPath, log);

    expect(result).toBe('migrated');
    expect(await fs.readFile(targetPath, 'utf-8')).toBe('{"language":"ru"}');
    expect(await exists(legacyPath)).toBe(false);
    expect(await exists(path.dirname(legacyPath))).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('migrated');
  });

  test('no-op when there is no legacy file', async () => {
    const result = await migrateLegacyPreferences(legacyPath, targetPath, log);

    expect(result).toBe('no-legacy-file');
    expect(await exists(targetPath)).toBe(false);
    expect(logs).toHaveLength(0);
  });

  test('never overwrites an existing target; removes the stale legacy copy', async () => {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{"language":"old"}', 'utf-8');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, '{"language":"new"}', 'utf-8');

    const result = await migrateLegacyPreferences(legacyPath, targetPath, log);

    expect(result).toBe('target-already-exists');
    expect(await fs.readFile(targetPath, 'utf-8')).toBe('{"language":"new"}');
    expect(await exists(legacyPath)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('is idempotent: second run does nothing', async () => {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{"language":"ru"}', 'utf-8');

    expect(await migrateLegacyPreferences(legacyPath, targetPath, log)).toBe('migrated');
    expect(await migrateLegacyPreferences(legacyPath, targetPath, log)).toBe('no-legacy-file');
    expect(await fs.readFile(targetPath, 'utf-8')).toBe('{"language":"ru"}');
    expect(logs).toHaveLength(1);
  });

  test('does not remove legacy dir when it still has other files', async () => {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{}', 'utf-8');
    await fs.writeFile(path.join(path.dirname(legacyPath), 'other.txt'), 'x', 'utf-8');

    await migrateLegacyPreferences(legacyPath, targetPath, log);

    expect(await exists(path.dirname(legacyPath))).toBe(true);
  });
});

describe('migratePraxisProjects', () => {
  const legacy = path.join(os.tmpdir(), 'legacy-proj');

  test('no legacy key returns the same object reference', () => {
    const prefs = { language: 'en', praxisProjects: [] };
    expect(migratePraxisProjects(prefs)).toBe(prefs);
  });

  test('legacy path with no projects becomes the default project', () => {
    const out = migratePraxisProjects({ praxisProjectPath: legacy }) as Record<string, unknown>;
    expect(out.praxisProjectPath).toBeUndefined();
    expect(out.praxisProjects).toEqual([{ path: legacy, name: 'legacy-proj', isDefault: true }]);
  });

  test('legacy path already registered leaves projects unchanged and drops the key', () => {
    const projects = [{ path: legacy, name: 'Mine', isDefault: true }];
    const out = migratePraxisProjects({ praxisProjectPath: legacy, praxisProjects: projects }) as Record<string, unknown>;
    expect(out.praxisProjectPath).toBeUndefined();
    expect(out.praxisProjects).toEqual(projects);
  });

  test('legacy path next to an existing default is not default', () => {
    const existing = { path: path.join(os.tmpdir(), 'other'), name: 'other', isDefault: true };
    const out = migratePraxisProjects({ praxisProjectPath: legacy, praxisProjects: [existing] }) as Record<string, unknown>;
    const list = out.praxisProjects as Array<{ path: string; isDefault: boolean }>;
    expect(list).toHaveLength(2);
    expect(list[0].isDefault).toBe(true);
    expect(list[1].path).toBe(legacy);
    expect(list[1].isDefault).toBe(false);
  });
});

describe('sanitizePraxisProjects', () => {
  test('drops entries without a path and non-objects', () => {
    expect(sanitizePraxisProjects([{ name: 'x' }, null, 'str', { path: '  ' }])).toEqual([]);
    expect(sanitizePraxisProjects('nope')).toEqual([]);
  });

  test('trims path and name, falls back to basename', () => {
    const p = path.join(os.tmpdir(), 'abc');
    const out = sanitizePraxisProjects([{ path: `  ${p}  `, name: '  ' }, { path: path.join(p, 'x'), name: ' Named ' }]);
    expect(out[0].path).toBe(p);
    expect(out[0].name).toBe('abc');
    expect(out[1].name).toBe('Named');
  });

  test('dedupes the same path', () => {
    const p = path.join(os.tmpdir(), 'dup');
    expect(sanitizePraxisProjects([{ path: p }, { path: p + path.sep }])).toHaveLength(1);
  });

  test('keeps only the first isDefault', () => {
    const a = path.join(os.tmpdir(), 'a');
    const b = path.join(os.tmpdir(), 'b');
    const out = sanitizePraxisProjects([{ path: a, isDefault: true }, { path: b, isDefault: true }]);
    expect(out.map((x) => x.isDefault)).toEqual([true, false]);
  });
});

describe('sanitizeCompactPreferences', () => {
  test('booleans are strict', () => {
    const out = sanitizeCompactPreferences({ compactEnabled: 'yes', compactAlwaysOnTop: true });
    expect(out.compactEnabled).toBe(false);
    expect(out.compactAlwaysOnTop).toBe(true);
  });

  test('unknown enum value is dropped, valid one kept', () => {
    const out = sanitizeCompactPreferences({ compactMode: 'bogus', compactExpandOn: 'click' });
    expect('compactMode' in out).toBe(false);
    expect(out.compactExpandOn).toBe('click');
  });

  test('strip width clamps and non-numeric is dropped', () => {
    expect(sanitizeCompactPreferences({ compactStripWidth: 100 }).compactStripWidth).toBe(280);
    expect(sanitizeCompactPreferences({ compactStripWidth: 999 }).compactStripWidth).toBe(520);
    expect(sanitizeCompactPreferences({ compactStripWidth: 361.6 }).compactStripWidth).toBe(362);
    expect('compactStripWidth' in sanitizeCompactPreferences({ compactStripWidth: 'wide' })).toBe(false);
  });

  test('unrelated keys pass through untouched', () => {
    expect(sanitizeCompactPreferences({ language: 'en' })).toEqual({ language: 'en' });
  });
});
