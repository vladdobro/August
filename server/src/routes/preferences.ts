import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { PREFS_PATH } from '../services/preferencesStore.js';

const router = Router();

async function readPrefs(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(PREFS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writePrefs(prefs: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(PREFS_PATH), { recursive: true });
  await fs.writeFile(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf-8');
}

const ALLOWED_KEYS = new Set([
  'language',
  'micDeviceId',
  'systemAudio',
  'systemAudioSource',
  'recordingMode',
  'liveEngine',
  'audioBoost',
  'retranscriptionLanguage',
  'praxisProjectPath',
  'sidebarCollapsed',
  'sessionSortOrder',
  'skipStopConfirmation',
  'skipClearConfirmation',
]);

// GET /api/preferences
router.get('/', async (_req, res) => {
  const prefs = await readPrefs();
  res.json(prefs);
});

// PATCH /api/preferences
router.patch('/', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Request body must be a JSON object' });
    return;
  }

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_KEYS.has(key)) {
      patch[key] = value;
    }
  }

  const current = await readPrefs();
  const merged = { ...current, ...patch };
  await writePrefs(merged);
  res.json(merged);
});

// DELETE /api/preferences
router.delete('/', async (_req, res) => {
  try {
    await fs.unlink(PREFS_PATH);
  } catch {
    // file didn't exist, that's fine
  }
  res.json({});
});

export default router;
