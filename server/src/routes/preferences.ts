import fs from 'node:fs/promises';
import { Router } from 'express';
import {
  PREFS_PATH,
  readPreferencesMigrated,
  writePreferences,
  sanitizePraxisProjects,
  migratePraxisProjects,
} from '../services/preferencesStore.js';

const router = Router();

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
  'praxisProjects',
  'praxisDefaultPrompt',
  'sidebarCollapsed',
  'sessionSortOrder',
  'skipStopConfirmation',
  'skipClearConfirmation',
  'gpuEngine',
]);

// GET /api/preferences
router.get('/', async (_req, res) => {
  const prefs = await readPreferencesMigrated();
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

  if ('praxisProjects' in patch) {
    patch.praxisProjects = sanitizePraxisProjects(patch.praxisProjects);
  }
  if ('praxisDefaultPrompt' in patch) {
    patch.praxisDefaultPrompt = typeof patch.praxisDefaultPrompt === 'string' ? patch.praxisDefaultPrompt : null;
  }

  const current = await readPreferencesMigrated();
  const merged = migratePraxisProjects({ ...current, ...patch });
  await writePreferences(merged);
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
