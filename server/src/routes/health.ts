import fs from 'node:fs/promises';
import { Router } from 'express';

import { config, ENV_FILE_PATH } from '../config.js';
import { checkFfmpegAvailable, fileExists, FFMPEG_MISSING_MESSAGE } from '../services/whisper.js';
import { gpuState } from '../services/gpuBackend.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const [whisperAvailable, modelAvailable, ffmpegAvailable] = await Promise.all([
    fileExists(config.whisperBinPath),
    fileExists(config.whisperModelPath),
    checkFfmpegAvailable(),
  ]);

  res.json({
    status: 'ok',
    whisperAvailable,
    modelAvailable,
    ffmpegAvailable,
    ffmpegMessage: ffmpegAvailable ? null : FFMPEG_MISSING_MESSAGE,
    gpuBackend: gpuState.backend(),
    groqAvailable: !!config.groqApiKey,
  });
});

router.post('/config/groq-key', async (req, res) => {
  const { key } = req.body ?? {};
  if (typeof key !== 'string' || !key.trim()) {
    res.status(400).json({ error: 'Missing key' });
    return;
  }

  const trimmed = key.trim();

  let envContent = '';
  try {
    envContent = await fs.readFile(ENV_FILE_PATH, 'utf-8');
  } catch {
    // .env doesn't exist yet
  }

  const keyLine = `GROQ_API_KEY=${trimmed}`;
  if (/^GROQ_API_KEY=/m.test(envContent)) {
    envContent = envContent.replace(/^GROQ_API_KEY=.*$/m, keyLine);
  } else {
    envContent = envContent.trimEnd() + '\n' + keyLine + '\n';
  }

  await fs.writeFile(ENV_FILE_PATH, envContent, 'utf-8');
  config.groqApiKey = trimmed;

  res.json({ ok: true, groqAvailable: true });
});

export default router;
