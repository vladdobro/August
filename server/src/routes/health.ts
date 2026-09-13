import { Router } from 'express';

import { config } from '../config.js';
import { checkFfmpegAvailable, fileExists, FFMPEG_MISSING_MESSAGE } from '../services/whisper.js';

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
    groqAvailable: !!config.groqApiKey,
  });
});

export default router;
