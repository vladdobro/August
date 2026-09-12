import { Router } from 'express';

import { getModelStatus, onModelStatus, type ModelStatus } from '../services/modelDownloader.js';

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

export default router;
