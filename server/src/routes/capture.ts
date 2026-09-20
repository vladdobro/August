import { Router, type Request, type Response, type NextFunction } from 'express';

import { CaptureError, detectCapabilities, startCapture, stopCapture } from '../services/systemCapture.js';

/// System audio capture endpoints (AUG-105). These spawn OS-level audio
/// processes, so unlike the rest of the API they refuse non-loopback callers
/// even though the HTTP server itself listens on all interfaces.
///
///   GET  /api/capture/capabilities            → CaptureCapabilities (add ?refresh=1 to bypass the 30 s cache)
///   POST /api/capture/start { live?: boolean }  → { captureId, startedAt, spawnedAt, startedAtSource, live }
///   POST /api/capture/stop  { captureId }     → { captureId, path, startedAt, spawnedAt, startedAtSource, durationMs }
///   startedAt is the first-written-byte time (startedAtSource 'first-byte'), falling back to
///   spawnedAt after 2 s without audio (startedAtSource 'spawn') — see systemCapture.ts (AUG-108).
///   live: true (AUG-113) tees 16 kHz PCM for the live-transcription WebSocket (attach-capture frame).

const router = Router();

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? '';
  if (!LOOPBACK_ADDRESSES.has(addr)) {
    res.status(403).json({ error: 'Capture endpoints are reachable only from this machine (loopback)' });
    return;
  }
  next();
}

router.use(loopbackOnly);

// GET /api/capture/capabilities
router.get('/capabilities', async (req, res) => {
  const caps = await detectCapabilities(req.query.refresh === '1');
  res.json(caps);
});

// POST /api/capture/start
router.post('/start', async (req, res) => {
  const live = req.body?.live === true;
  try {
    const started = await startCapture({ live });
    res.status(201).json(started);
  } catch (err) {
    const message = err instanceof CaptureError ? err.message : (err as Error)?.message || 'Failed to start system capture';
    res.status(400).json({ error: message });
  }
});

// POST /api/capture/stop
router.post('/stop', async (req, res) => {
  const captureId = typeof req.body?.captureId === 'string' ? req.body.captureId.trim() : '';
  if (!captureId) {
    res.status(400).json({ error: 'captureId is required' });
    return;
  }
  try {
    const stopped = await stopCapture(captureId);
    res.json(stopped);
  } catch (err) {
    const message = err instanceof CaptureError ? err.message : (err as Error)?.message || 'Failed to stop system capture';
    res.status(message.startsWith('Unknown') ? 404 : 500).json({ error: message });
  }
});

export default router;
