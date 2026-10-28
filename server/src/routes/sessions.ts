import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Response } from 'express';
import multer from 'multer';

import { config } from '../config.js';
import * as sessionManager from '../services/sessionManager.js';
import { transcribe, ensureWav, boostAudio, checkFfmpegAvailable, getAudioDuration, WhisperError, cancelTranscription, beginTranscriptionJob, isTranscribing, FFMPEG_MISSING_MESSAGE, fileExists } from '../services/whisper.js';
import { mergeSingleStream, mergeDualStream, renderTranscript, alignDualSegments, alignedDualDuration, describeTrackMismatch } from '../services/transcriptMerger.js';
import { recordCompletion, getEstimatedDuration } from '../services/performanceTracker.js';
import { getModelStatus } from '../services/modelDownloader.js';
import { consumeCapture, hasCapture, CaptureError } from '../services/systemCapture.js';
import { downloadFromUrl, UrlDownloadError } from '../services/urlDownloader.js';
import { isPlatformUrl, probePlatformVideo, downloadPlatformAudio, YtDlpError, YTDLP_MISSING_MESSAGE, INFO_JSON_NAME } from '../services/ytDlp.js';
import type { TranscriptionLanguage } from '../types.js';

const router = Router();

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const upload = multer({
  dest: config.uploadsDir,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const ALLOWED_LANGUAGES: TranscriptionLanguage[] = ['auto', 'en', 'ru'];

const activeDownloads = new Map<string, AbortController>();

export function cancelDownload(sessionId: string): boolean {
  const controller = activeDownloads.get(sessionId);
  if (!controller) return false;
  controller.abort();
  activeDownloads.delete(sessionId);
  return true;
}

function normalizeLanguage(value: unknown): TranscriptionLanguage {
  if (typeof value === 'string' && (ALLOWED_LANGUAGES as string[]).includes(value)) {
    return value as TranscriptionLanguage;
  }
  return 'ru';
}

interface DualTrackPrep {
  micSec: number;
  systemSec: number;
  duration: number;
  estimatedDuration: number;
  trackWarning: string | null;
}

/// Converts both tracks once (ensureWav reuses existing WAVs), measures both, and derives the real call length, the
/// ETA from the audio whisper will actually process (mic + system) and the length-mismatch notice (AUG-125).
async function prepareDualTracks(sessionId: string, micPath: string, systemPath: string, systemOffsetMs: number): Promise<DualTrackPrep> {
  const [micWav, systemWav] = await Promise.all([ensureWav(micPath), ensureWav(systemPath)]);
  const [micSec, systemSec] = await Promise.all([getAudioDuration(micWav), getAudioDuration(systemWav)]);
  const duration = alignedDualDuration(micSec, systemSec, systemOffsetMs);
  const workSec = micSec + systemSec;
  const estimatedDuration = workSec > 0 ? await getEstimatedDuration(workSec, true) : 0;
  const trackWarning = describeTrackMismatch(micSec, systemSec);
  if (trackWarning) console.warn(`[session ${sessionId}] ${trackWarning}`);
  return { micSec, systemSec, duration, estimatedDuration, trackWarning };
}

/// Runs the whisper transcription + merge/render pipeline for a session in
/// the background. Never awaited by the caller so the upload endpoint can
/// respond immediately with status "transcribing".
async function runTranscription(sessionId: string, audioPath: string, language: TranscriptionLanguage, boost = false) {
  const isCancelled = beginTranscriptionJob(sessionId);
  let boostedPath: string | null = null;
  try {
    let inputPath: string;
    if (boost) {
      // boost reads the extracted WAV so a video source never reaches the loudnorm chain (AUG-144)
      boostedPath = await boostAudio(await ensureWav(audioPath));
      inputPath = boostedPath;
    } else {
      inputPath = await ensureWav(audioPath);
    }

    const segments = await transcribe(inputPath, language, sessionId, isCancelled);
    const utterances = mergeSingleStream(segments);

    const session = await sessionManager.getSession(sessionId);
    const startedAt = session?.createdAt ?? new Date().toISOString();
    const duration = utterances.length > 0 ? utterances[utterances.length - 1].end : 0;

    const transcript = renderTranscript(utterances, startedAt, duration);
    await sessionManager.writeTranscript(sessionId, transcript);

    await sessionManager.updateSession(sessionId, {
      status: 'completed',
      duration,
    });

    const completedSession = await sessionManager.getSession(sessionId);
    if (completedSession?.transcriptionStartedAt) {
      const processingTime = (Date.now() - new Date(completedSession.transcriptionStartedAt).getTime()) / 1000;
      const audioSec = session?.duration && session.duration > 0 ? session.duration : duration;
      await recordCompletion(audioSec, processingTime, false);
    }

    // Boosted WAVs are kept after a failure or cancel so a retry reuses them (AUG-125); removed once the transcript is written.
    if (boostedPath) await fs.unlink(boostedPath).catch(() => {});
  } catch (err) {
    if (isCancelled()) return;
    const current = await sessionManager.getSession(sessionId);
    if (current?.status === 'failed') return;
    const message = err instanceof WhisperError ? err.message : (err as Error)?.message || 'Transcription failed';
    await sessionManager.updateSession(sessionId, { status: 'failed', error: message });
  }
}

async function runDualTranscription(
  sessionId: string,
  micPath: string,
  systemPath: string,
  language: TranscriptionLanguage,
  boost = false,
  systemOffsetMs = 0,
) {
  const isCancelled = beginTranscriptionJob(sessionId);
  let boostedMicPath: string | null = null;
  let boostedSystemPath: string | null = null;
  try {
    let micInput: string;
    let systemInput: string;
    if (boost) {
      [boostedMicPath, boostedSystemPath] = await Promise.all([boostAudio(micPath), boostAudio(systemPath)]);
      micInput = boostedMicPath;
      systemInput = boostedSystemPath;
    } else {
      [micInput, systemInput] = await Promise.all([ensureWav(micPath), ensureWav(systemPath)]);
    }

    // One track after the other through the shared batch slot (AUG-125, SplitVox): never two GPU-backed whisper-cli
    // processes at once.
    const micSegments = await transcribe(micInput, language, sessionId, isCancelled);
    const systemSegments = await transcribe(systemInput, language, sessionId, isCancelled);

    const aligned = alignDualSegments(micSegments, systemSegments, systemOffsetMs);
    const utterances = mergeDualStream(aligned.mic, aligned.system);

    const session = await sessionManager.getSession(sessionId);
    const startedAt = session?.createdAt ?? new Date().toISOString();
    const tracks = session?.trackDurations;
    const audioDuration = tracks ? alignedDualDuration(tracks.mic, tracks.system, systemOffsetMs) : 0;
    const lastEnd = utterances.length > 0 ? Math.max(...utterances.map((u) => u.end)) : 0;
    const duration = Math.max(audioDuration, lastEnd);

    const transcript = renderTranscript(utterances, startedAt, duration);
    await sessionManager.writeTranscript(sessionId, transcript);

    await sessionManager.updateSession(sessionId, {
      status: 'completed',
      duration,
    });

    const completedSession = await sessionManager.getSession(sessionId);
    if (completedSession?.transcriptionStartedAt) {
      const processingTime = (Date.now() - new Date(completedSession.transcriptionStartedAt).getTime()) / 1000;
      const workSec = tracks ? tracks.mic + tracks.system : duration;
      await recordCompletion(workSec, processingTime, true);
    }

    // Boosted WAVs are kept after a failure or cancel so a retry reuses them (AUG-125); removed once the transcript is written.
    if (boostedMicPath) await fs.unlink(boostedMicPath).catch(() => {});
    if (boostedSystemPath) await fs.unlink(boostedSystemPath).catch(() => {});
  } catch (err) {
    if (isCancelled()) return;
    const current = await sessionManager.getSession(sessionId);
    if (current?.status === 'failed') return;
    const message = err instanceof WhisperError ? err.message : (err as Error)?.message || 'Transcription failed';
    await sessionManager.updateSession(sessionId, { status: 'failed', error: message });
  }
}

async function prepareAndTranscribe(sessionId: string, audioPath: string, language: TranscriptionLanguage, boost = false) {
  try {
    const wavPath = await ensureWav(audioPath, sessionId);
    const audioDur = await getAudioDuration(wavPath);
    const estDur = audioDur > 0 ? await getEstimatedDuration(audioDur, false) : 0;
    await sessionManager.updateSession(sessionId, {
      status: 'transcribing',
      transcriptionStartedAt: new Date().toISOString(),
      duration: audioDur > 0 ? audioDur : undefined,
      ...(estDur > 0 ? { estimatedDuration: estDur } : {}),
    });
    void runTranscription(sessionId, audioPath, language, boost);
  } catch (err) {
    const current = await sessionManager.getSession(sessionId);
    if (current?.status === 'failed') return;
    const message = err instanceof WhisperError ? err.message : (err as Error)?.message || 'Failed to prepare audio';
    await sessionManager.updateSession(sessionId, { status: 'failed', error: message });
  }
}

async function findAudioFiles(sessionDir: string): Promise<{ mic: string | null; system: string | null; single: string | null }> {
  const entries = await fs.readdir(sessionDir);
  let mic: string | null = null;
  let system: string | null = null;
  let single: string | null = null;

  for (const entry of entries) {
    if (entry.startsWith('audio-mic.') && !mic) mic = path.join(sessionDir, entry);
    else if (entry.startsWith('audio-system.') && !system) system = path.join(sessionDir, entry);
    else if (entry.startsWith('audio.') && !single) single = path.join(sessionDir, entry);
  }

  return { mic, system, single };
}

/// Moves a file across the data dir; falls back to copy+unlink if rename is
/// refused (e.g. different volumes).
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch {
    await fs.copyFile(from, to);
    await fs.unlink(from).catch(() => {});
  }
}

// GET /api/sessions
router.get('/', async (_req, res) => {
  const sessions = await sessionManager.listSessions();
  res.json(sessions);
});

// GET /api/sessions/:id
router.get('/:id', async (req, res) => {
  const session = await sessionManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

// GET /api/sessions/:id/transcript
router.get('/:id/transcript', async (req, res) => {
  const session = await sessionManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const transcript = await sessionManager.getTranscript(req.params.id);
  if (transcript === null) {
    res.status(404).json({ error: 'Transcript not available yet' });
    return;
  }
  res.type('text/markdown').send(transcript);
});

// DELETE /api/sessions/:id
router.delete('/:id', async (req, res) => {
  const session = await sessionManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await sessionManager.deleteSession(req.params.id);
  res.status(204).end();
});

// PATCH /api/sessions/:id
router.patch('/:id', async (req, res) => {
  const { title } = req.body as { title?: string };
  if (!title || typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'Title is required' });
    return;
  }
  const session = await sessionManager.updateSession(req.params.id, { title: title.trim() });
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

// POST /api/sessions/upload
const uploadFields = upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'systemAudio', maxCount: 1 },
]);

router.post('/upload', (req, res, next) => {
  uploadFields(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'File is too large. Maximum is 2 GB.' });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
      return;
    }
    next();
  });
}, async (req, res) => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  const micFile = files?.['audio']?.[0];
  if (!micFile) {
    res.status(400).json({ error: 'No audio file uploaded (expected field "audio")' });
    return;
  }

  const systemFile = files?.['systemAudio']?.[0];
  const language = normalizeLanguage(req.body?.language);
  // AUG-105: a server-side capture can stand in for the systemAudio multipart file.
  const captureId = typeof req.body?.captureId === 'string' && req.body.captureId.trim() ? req.body.captureId.trim() : null;
  const micStartedAt = Number(req.body?.micStartedAt);
  const isDual = !!systemFile || !!captureId;

  if (systemFile && captureId) {
    res.status(400).json({ error: 'Send either a systemAudio file or a captureId, not both' });
    return;
  }
  if (captureId && !hasCapture(captureId)) {
    res.status(400).json({ error: 'Unknown or expired captureId — the system audio capture was not found on the server' });
    return;
  }

  // Preflight: catch missing dependencies before creating a session
  const needsFfmpeg = !micFile.originalname.toLowerCase().endsWith('.wav')
    || (systemFile && !systemFile.originalname.toLowerCase().endsWith('.wav'));
  if (needsFfmpeg && !(await checkFfmpegAvailable())) {
    res.status(400).json({ error: FFMPEG_MISSING_MESSAGE });
    return;
  }
  if (!(await fileExists(config.whisperBinPath))) {
    const binName = path.basename(config.whisperBinPath);
    res.status(400).json({
      error: `${binName} not found at "${config.whisperBinPath}". Run \`npm run setup\` to download it.`,
    });
    return;
  }
  if (!(await fileExists(config.whisperModelPath))) {
    const modelStatus = getModelStatus();
    if (modelStatus.state === 'downloading') {
      res.status(400).json({
        error: `Whisper model is still downloading (${modelStatus.percent}%). Try again when it finishes.`,
      });
    } else {
      res.status(400).json({
        error: `Whisper model not found. Restart the server to auto-download it.`,
      });
    }
    return;
  }

  let createdSessionId: string | null = null;
  try {
    const session = await sessionManager.createSession(
      isDual ? undefined : micFile.originalname,
      language,
      isDual,
    );
    createdSessionId = session.id;
    const sessionDir = sessionManager.sessionAudioDir(session.id);

    if (isDual) {
      const micExt = path.extname(micFile.originalname) || '.wav';
      const micDest = path.join(sessionDir, `audio-mic${micExt}`);
      await fs.copyFile(micFile.path, micDest);
      await fs.unlink(micFile.path).catch(() => {});

      let sysDest: string;
      let systemOffsetMs = 0;
      if (captureId) {
        const capture = await consumeCapture(captureId);
        sysDest = path.join(sessionDir, 'audio-system.wav');
        await moveFile(capture.path, sysDest);
        if (Number.isFinite(micStartedAt) && micStartedAt > 0) {
          systemOffsetMs = capture.startedAt - micStartedAt;
        }
      } else {
        const sysExt = path.extname(systemFile!.originalname) || '.wav';
        sysDest = path.join(sessionDir, `audio-system${sysExt}`);
        await fs.copyFile(systemFile!.path, sysDest);
        await fs.unlink(systemFile!.path).catch(() => {});
      }

      const prep = await prepareDualTracks(session.id, micDest, sysDest, systemOffsetMs);
      const inProgress = await sessionManager.updateSession(session.id, {
        status: 'transcribing',
        transcriptionStartedAt: new Date().toISOString(),
        duration: prep.duration > 0 ? prep.duration : undefined,
        ...(prep.estimatedDuration > 0 ? { estimatedDuration: prep.estimatedDuration } : {}),
        trackDurations: { mic: prep.micSec, system: prep.systemSec },
        trackWarning: prep.trackWarning ?? undefined,
        ...(systemOffsetMs !== 0 ? { systemOffsetMs } : {}),
      });
      void runDualTranscription(session.id, micDest, sysDest, language, false, systemOffsetMs);
      res.status(201).json(inProgress ?? session);
    } else {
      const ext = path.extname(micFile.originalname).toLowerCase() || '.wav';
      const destPath = path.join(sessionDir, `audio${ext}`);
      await fs.copyFile(micFile.path, destPath);
      await fs.unlink(micFile.path).catch(() => {});

      const needsConversion = ext !== '.wav';
      if (needsConversion) {
        const preparing = await sessionManager.updateSession(session.id, {
          status: 'preparing',
        });
        res.status(201).json(preparing ?? session);
        void prepareAndTranscribe(session.id, destPath, language);
      } else {
        const audioDur = await getAudioDuration(destPath);
        const estDur = audioDur > 0 ? await getEstimatedDuration(audioDur, false) : 0;
        const inProgress = await sessionManager.updateSession(session.id, {
          status: 'transcribing',
          transcriptionStartedAt: new Date().toISOString(),
          duration: audioDur > 0 ? audioDur : undefined,
          ...(estDur > 0 ? { estimatedDuration: estDur } : {}),
        });
        void runTranscription(session.id, destPath, language);
        res.status(201).json(inProgress ?? session);
      }
    }
  } catch (err) {
    if (createdSessionId) {
      await sessionManager.updateSession(createdSessionId, {
        status: 'failed',
        error: (err as Error)?.message || 'Failed to start transcription',
      }).catch(() => {});
    }
    const status = err instanceof CaptureError ? 400 : 500;
    res.status(status).json({ error: (err as Error)?.message || 'Failed to start transcription' });
  }
});

function formatHours(sec: number): string {
  return sec < 3600 ? `${Math.ceil(sec / 60)} min` : `${Number((sec / 3600).toFixed(1))} h`;
}

/// Platform-link flow (AUG-149): metadata probe (title, duration guard, live check) → yt-dlp audio download with progress
/// → the standard preparing → transcribing pipeline. The session sits in "uploading" with sourceUrl set while yt-dlp runs;
/// yt-dlp children live in the shared process map, so cancel kills them and orphan recovery sees them.
async function startPlatformDownload(res: Response, url: string, language: TranscriptionLanguage): Promise<void> {
  if (config.ytDlpSource !== 'path' && !(await fileExists(config.ytDlpPath))) {
    res.status(400).json({ error: YTDLP_MISSING_MESSAGE });
    return;
  }

  let title = 'Video link';
  try {
    title = `Video from ${new URL(url).hostname.replace(/^www\./, '')}`;
  } catch {
    // keep default title
  }

  let createdSessionId: string | null = null;
  try {
    const session = await sessionManager.createSession(title, language);
    createdSessionId = session.id;
    const updated = await sessionManager.updateSession(session.id, {
      sourceUrl: url,
      downloadProgress: 0,
    });

    // Respond immediately
    res.status(201).json(updated ?? session);

    const sessionDir = sessionManager.sessionAudioDir(session.id);
    const controller = new AbortController();
    activeDownloads.set(session.id, controller);

    // Progress writes are chained, not fired in parallel: updateSession is read-modify-write on session.json, and a short
    // video finishes within milliseconds, so overlapping writes left the status update reading a truncated file.
    let progressWrites: Promise<unknown> = Promise.resolve();

    void (async () => {
      try {
        const info = await probePlatformVideo(url, { destDir: sessionDir, sessionKey: session.id, signal: controller.signal });
        if (info.isLive) {
          throw new YtDlpError('Live streams and upcoming premieres cannot be transcribed — try again after the stream has ended.');
        }
        if (info.durationSec !== null && info.durationSec > config.ytDlpMaxDurationSec) {
          throw new YtDlpError(`This video is ${formatHours(info.durationSec)} long — the limit is ${formatHours(config.ytDlpMaxDurationSec)}.`);
        }
        if (info.title) await sessionManager.updateSession(session.id, { title: info.title });

        const result = await downloadPlatformAudio(info.infoJsonPath, {
          destDir: sessionDir,
          sessionKey: session.id,
          signal: controller.signal,
          onProgress: (percent) => {
            progressWrites = progressWrites
              .then(() => sessionManager.updateSession(session.id, { downloadProgress: percent }))
              .catch(() => {});
          },
        });

        activeDownloads.delete(session.id);
        await progressWrites;
        if (controller.signal.aborted) return;

        await sessionManager.updateSession(session.id, { status: 'preparing', downloadProgress: undefined });
        void prepareAndTranscribe(session.id, result.filePath, language);
      } catch (err) {
        activeDownloads.delete(session.id);
        await progressWrites;
        await fs.unlink(path.join(sessionDir, INFO_JSON_NAME)).catch(() => {});
        const current = await sessionManager.getSession(session.id);
        if (current?.status === 'failed') return;
        const message = err instanceof YtDlpError
          ? err.message
          : (err as Error)?.message || 'Download failed';
        await sessionManager.updateSession(session.id, {
          status: 'failed',
          error: message,
          downloadProgress: undefined,
        });
      }
    })();
  } catch (err) {
    if (createdSessionId) {
      await sessionManager.updateSession(createdSessionId, {
        status: 'failed',
        error: (err as Error)?.message || 'Failed to start download',
      }).catch(() => {});
    }
    if (!res.headersSent) {
      const message = err instanceof YtDlpError ? err.message : (err as Error)?.message || 'Failed to start download';
      res.status(400).json({ error: message });
    }
  }
}

// POST /api/sessions/from-url
router.post('/from-url', async (req, res) => {
  const { url, language: rawLang } = req.body as { url?: string; language?: string };

  if (!url || typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'URL is required' });
    return;
  }

  const language = normalizeLanguage(rawLang);

  // Video-site links (YouTube, Vimeo, …) go through yt-dlp (AUG-149); everything else keeps the direct-download path (AUG-148).
  if (isPlatformUrl(url)) {
    await startPlatformDownload(res, url.trim(), language);
    return;
  }

  // Derive a title from the URL path
  let title = 'Link download';
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').pop() || '';
    const decoded = decodeURIComponent(lastSegment).trim();
    if (decoded && decoded !== '/') title = decoded;
  } catch {
    // keep default title
  }

  let createdSessionId: string | null = null;
  try {
    const session = await sessionManager.createSession(title, language);
    createdSessionId = session.id;
    const updated = await sessionManager.updateSession(session.id, {
      sourceUrl: url,
      downloadProgress: 0,
    });

    // Respond immediately
    res.status(201).json(updated ?? session);

    // Background: download then transcribe
    const sessionDir = sessionManager.sessionAudioDir(session.id);
    const controller = new AbortController();
    activeDownloads.set(session.id, controller);

    // Chained like the platform path: overlapping read-modify-write updates of session.json can truncate it.
    let progressWrites: Promise<unknown> = Promise.resolve();

    void (async () => {
      try {
        const result = await downloadFromUrl(url, {
          destDir: sessionDir,
          signal: controller.signal,
          onProgress: (percent) => {
            progressWrites = progressWrites
              .then(() => sessionManager.updateSession(session.id, { downloadProgress: percent }))
              .catch(() => {});
          },
        });

        activeDownloads.delete(session.id);
        await progressWrites;

        // Update title from Content-Disposition filename if better
        if (result.fileName && result.fileName !== title) {
          await sessionManager.updateSession(session.id, { title: result.fileName });
        }

        // Clear download progress and start transcription
        await sessionManager.updateSession(session.id, { downloadProgress: undefined });

        const needsConversion = result.extension !== '.wav';
        if (needsConversion) {
          await sessionManager.updateSession(session.id, { status: 'preparing' });
          void prepareAndTranscribe(session.id, result.filePath, language);
        } else {
          const audioDur = await getAudioDuration(result.filePath);
          const estDur = audioDur > 0 ? await getEstimatedDuration(audioDur, false) : 0;
          await sessionManager.updateSession(session.id, {
            status: 'transcribing',
            transcriptionStartedAt: new Date().toISOString(),
            duration: audioDur > 0 ? audioDur : undefined,
            ...(estDur > 0 ? { estimatedDuration: estDur } : {}),
          });
          void runTranscription(session.id, result.filePath, language);
        }
      } catch (err) {
        activeDownloads.delete(session.id);
        await progressWrites;
        const current = await sessionManager.getSession(session.id);
        if (current?.status === 'failed') return;
        const message = err instanceof UrlDownloadError
          ? err.message
          : (err as Error)?.message || 'Download failed';
        await sessionManager.updateSession(session.id, {
          status: 'failed',
          error: message,
          downloadProgress: undefined,
        });
      }
    })();
  } catch (err) {
    if (createdSessionId) {
      await sessionManager.updateSession(createdSessionId, {
        status: 'failed',
        error: (err as Error)?.message || 'Failed to start download',
      }).catch(() => {});
    }
    if (!res.headersSent) {
      const message = err instanceof UrlDownloadError ? err.message : (err as Error)?.message || 'Failed to start download';
      res.status(400).json({ error: message });
    }
  }
});

// POST /api/sessions/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  const session = await sessionManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.status !== 'transcribing' && session.status !== 'preparing' && session.status !== 'uploading') {
    res.status(400).json({ error: 'Session is not currently transcribing or downloading' });
    return;
  }
  cancelDownload(req.params.id);
  cancelTranscription(req.params.id);
  const updated = await sessionManager.updateSession(req.params.id, {
    status: 'failed',
    error: 'Transcription cancelled by user',
  });
  res.json(updated ?? session);
});

// POST /api/sessions/:id/retranscribe
router.post('/:id/retranscribe', async (req, res) => {
  const session = await sessionManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const { boost } = req.body as { boost?: boolean; language?: string };

  if (boost) {
    const ffmpegOk = await checkFfmpegAvailable();
    if (!ffmpegOk) {
      res.status(400).json({ error: FFMPEG_MISSING_MESSAGE });
      return;
    }
  }

  // Preflight: ensure whisper-cli and model are present before flipping status
  const whisperBinOk = await fileExists(config.whisperBinPath);
  if (!whisperBinOk) {
    const binName = path.basename(config.whisperBinPath);
    res.status(400).json({
      error: `${binName} not found at "${config.whisperBinPath}". Run \`npm run setup\` to download it.`,
    });
    return;
  }
  const whisperModelOk = await fileExists(config.whisperModelPath);
  if (!whisperModelOk) {
    const modelStatus = getModelStatus();
    if (modelStatus.state === 'downloading') {
      res.status(400).json({
        error: `Whisper model is still downloading (${modelStatus.percent}%). Try again when it finishes.`,
      });
    } else {
      res.status(400).json({
        error: `Whisper model not found. Restart the server to auto-download it.`,
      });
    }
    return;
  }

  // Cancel any running transcription before restarting
  cancelTranscription(req.params.id);

  const language = normalizeLanguage(req.body?.language ?? session.language);
  const audioDir = sessionManager.sessionAudioDir(req.params.id);
  const audioFiles = await findAudioFiles(audioDir);

  if (session.dualTrack && audioFiles.mic && audioFiles.system) {
    const systemOffsetMs = session.systemOffsetMs ?? 0;
    const prep = await prepareDualTracks(req.params.id, audioFiles.mic, audioFiles.system, systemOffsetMs);
    const updated = await sessionManager.updateSession(req.params.id, {
      status: 'transcribing',
      error: undefined,
      transcriptionStartedAt: new Date().toISOString(),
      duration: prep.duration > 0 ? prep.duration : undefined,
      ...(prep.estimatedDuration > 0 ? { estimatedDuration: prep.estimatedDuration } : {}),
      trackDurations: { mic: prep.micSec, system: prep.systemSec },
      trackWarning: prep.trackWarning ?? undefined,
    });
    void runDualTranscription(req.params.id, audioFiles.mic, audioFiles.system, language, !!boost, systemOffsetMs);
    res.json(updated ?? session);
  } else if (audioFiles.single) {
    const singleExt = path.extname(audioFiles.single).toLowerCase();
    const needsConversion = singleExt !== '.wav';
    if (needsConversion) {
      const updated = await sessionManager.updateSession(req.params.id, {
        status: 'preparing',
        error: undefined,
      });
      res.json(updated ?? session);
      void prepareAndTranscribe(req.params.id, audioFiles.single, language, !!boost);
    } else {
      const audioDur = await getAudioDuration(audioFiles.single);
      const estDur = audioDur > 0 ? await getEstimatedDuration(audioDur, false) : 0;
      const updated = await sessionManager.updateSession(req.params.id, {
        status: 'transcribing',
        error: undefined,
        transcriptionStartedAt: new Date().toISOString(),
        duration: audioDur > 0 ? audioDur : undefined,
        ...(estDur > 0 ? { estimatedDuration: estDur } : {}),
      });
      void runTranscription(req.params.id, audioFiles.single, language, !!boost);
      res.json(updated ?? session);
    }
  } else {
    res.status(400).json({ error: 'Audio file no longer exists for this session' });
  }
});

export async function recoverOrphanedSessions() {
  try {
    const sessions = await sessionManager.listSessions();
    for (const session of sessions) {
      if ((session.status === 'transcribing' || session.status === 'preparing' || (session.status === 'uploading' && session.sourceUrl)) && !isTranscribing(session.id) && !activeDownloads.has(session.id)) {
        await sessionManager.updateSession(session.id, {
          status: 'failed',
          error: 'Transcription interrupted (server restart or process crash)',
        });
        console.log(`Recovered orphaned session: ${session.id} (${session.title})`);
      }
    }
  } catch (err) {
    console.error('Failed to recover orphaned sessions:', err);
  }
}

export default router;
