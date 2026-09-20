import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyPreferences } from './preferencesStore.js';

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
