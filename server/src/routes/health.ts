import { Router } from 'express';
import fs from 'node:fs/promises';

import { config } from '../config.js';
import { checkFfmpegAvailable } from '../services/whisper.js';

const router = Router();

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

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
  });
});

export default router;
