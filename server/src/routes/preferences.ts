import fs from 'node:fs/promises';
import { Router } from 'express';
import {
  PREFS_PATH,
  readPreferencesMigrated,
  writePreferences,
  sanitizePraxisProjects,
  sanitizePraxisRecentPaths,
  sanitizeCompactPreferences,
  sanitizeAssistantPreferences,
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
  'praxisRecentPaths',
  'sidebarCollapsed',
  'sessionSortOrder',
  'skipStopConfirmation',
  'skipClearConfirmation',
  'gpuEngine',
  'autoDeleteWav',
  'autoDeleteWavThreshold',
  'llmCorrections',
  'batchCorrectionEngine',
  'groqLiveCorrection',
  'groqLiveActionItems',
  'compactEnabled',
  'compactMode',
  'compactIndicatorWidget',
  'compactTranscriptWidget',
  'compactAlwaysOnTop',
  'compactExpandOn',
  'compactStripWidth',
  'compactCaptionHeight',
  'compactCaptionWidth',
  'compactCaptionFontSize',
  'compactCaptionOpacity',
  'compactHintSeen',
  // AUG-198: AI assistants (mode / enabled / consents are written only by /api/assistant)
  'aiCopilotModel',
  'aiCopilotAlwaysBudgetUsd',
  'aiModel',
  'aiSessionBudgetUsd',
  'aiTranscriptWindowMin',
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
  // AUG-190: default on; only an explicit false turns it off.
  if ('groqLiveCorrection' in patch) patch.groqLiveCorrection = patch.groqLiveCorrection !== false;
  if ('groqLiveActionItems' in patch) patch.groqLiveActionItems = patch.groqLiveActionItems !== false;
  if ('batchCorrectionEngine' in patch) {
    if (patch.batchCorrectionEngine !== 'local' && patch.batchCorrectionEngine !== 'groq') delete patch.batchCorrectionEngine;
  }
  if ('autoDeleteWavThreshold' in patch) {
    const n = Number(patch.autoDeleteWavThreshold);
    if (Number.isFinite(n)) patch.autoDeleteWavThreshold = Math.min(95, Math.max(50, Math.round(n)));
    else delete patch.autoDeleteWavThreshold;
  }
  patch = sanitizeCompactPreferences(patch);
  patch = sanitizeAssistantPreferences(patch);

  const current = await readPreferencesMigrated();
  const merged = migratePraxisProjects({ ...current, ...patch });
  // AUG-192: re-check recents on every PATCH, so a path saved as a project leaves the Recent list.
  if ('praxisRecentPaths' in merged) {
    merged.praxisRecentPaths = sanitizePraxisRecentPaths(merged.praxisRecentPaths, merged.praxisProjects);
  }
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
