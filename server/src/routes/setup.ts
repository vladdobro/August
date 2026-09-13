import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Router } from 'express';

import { config } from '../config.js';
import { ensureWhisperModel, getModelStatus, onModelStatus, type ModelStatus } from '../services/modelDownloader.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json(getModelStatus());
});

router.get('/download-progress', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (s: ModelStatus) => {
    const payload = {
      percent: s.percent,
      bytesDownloaded: s.bytesDownloaded,
      totalBytes: s.totalBytes,
      state: s.state,
      verifying: s.verifying,
      error: s.error,
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const current = getModelStatus();
  send(current);

  if (current.state !== 'downloading') {
    res.end();
    return;
  }

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);

  const unsubscribe = onModelStatus((s) => {
    send(s);
    if (s.state !== 'downloading') {
      cleanup();
      res.end();
    }
  });

  function cleanup() {
    clearInterval(heartbeat);
    unsubscribe();
  }

  req.on('close', cleanup);
});

router.post('/download-model', (_req, res) => {
  const status = getModelStatus();
  if (status.state === 'downloading') {
    res.json({ ok: true, message: 'Already downloading' });
    return;
  }
  void ensureWhisperModel();
  res.json({ ok: true, message: 'Download started' });
});

router.post('/open-model-folder', async (_req, res) => {
  const dir = path.dirname(config.whisperModelPath);
  await fs.mkdir(dir, { recursive: true });

  const cmd = process.platform === 'win32'
    ? `explorer.exe "${dir}"`
    : `open "${dir}"`;

  exec(cmd, (err) => {
    if (err) {
      res.status(500).json({ error: 'Could not open folder' });
    } else {
      res.json({ ok: true, path: dir });
    }
  });
});

export default router;
