import fs from 'node:fs/promises';
import { Router } from 'express';
import {
  PREFS_PATH,
  readPreferencesMigrated,
  writePreferences,
  sanitizePraxisProjects,
  sanitizeCompactPreferences,
  migratePraxisProjects,
} from '../services/preferencesStore.js';
import { stopLlmServer } from '../services/llmServer.js';

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
  'autoDeleteWav',
  'autoDeleteWavThreshold',
  'llmCorrections',
  'batchCorrectionEngine',
  'compactEnabled',
  'compactMode',
  'compactIndicatorWidget',
  'compactTranscriptWidget',
  'compactAlwaysOnTop',
  'compactExpandOn',
  'compactStripWidth',
  'compactCaptionHeight',
  'compactHintSeen',
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

  let patch: Record<string, unknown> = {};
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
  if ('autoDeleteWav' in patch) {
    patch.autoDeleteWav = patch.autoDeleteWav === true;
  }
  if ('llmCorrections' in patch) {
    patch.llmCorrections = patch.llmCorrections === true;
  }
  if ('batchCorrectionEngine' in patch) {
    if (patch.batchCorrectionEngine !== 'local' && patch.batchCorrectionEngine !== 'groq') delete patch.batchCorrectionEngine;
  }
  if ('autoDeleteWavThreshold' in patch) {
    const n = Number(patch.autoDeleteWavThreshold);
    if (Number.isFinite(n)) patch.autoDeleteWavThreshold = Math.min(95, Math.max(50, Math.round(n)));
    else delete patch.autoDeleteWavThreshold;
  }
  patch = sanitizeCompactPreferences(patch);

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
  // AUG-162: a reset turns the local language model off.
  void stopLlmServer('preferences reset');
  res.json({});
});

export default router;
