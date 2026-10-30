import { Router } from 'express';

import { config } from '../config.js';
import { groqKeyFingerprint, groqTextState } from '../services/groqText.js';
import { readPreferences, writePreferences } from '../services/preferencesStore.js';

/// Opt-in online text correction (AUG-164). Only these routes write groqTextEnabled / groqTextConsent to preferences;
/// DELETE /api/preferences also drops them, which resets the consent.
const router = Router();

router.get('/status', async (_req, res) => {
  res.json(groqTextState(await readPreferences()));
});

router.post('/enable', async (req, res) => {
  if (req.body?.accept !== true) {
    res.status(400).json({ error: 'Consent is required.' });
    return;
  }
  if (!config.groqApiKey) {
    res.status(409).json({ error: 'Add a Groq API key first.' });
    return;
  }
  const prefs = await readPreferences();
  await writePreferences({
    ...prefs,
    groqTextEnabled: true,
    groqTextConsent: { acceptedAt: new Date().toISOString(), keyFingerprint: groqKeyFingerprint(config.groqApiKey) },
  });
  res.json(groqTextState(await readPreferences()));
});

router.post('/disable', async (_req, res) => {
  const { groqTextConsent: _consent, ...rest } = await readPreferences();
  await writePreferences({ ...rest, groqTextEnabled: false });
  res.json(groqTextState(await readPreferences()));
});

export default router;
