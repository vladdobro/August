import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';

import { config } from '../config.js';
import * as sessionManager from '../services/sessionManager.js';
import { transcribe, ensureWav, boostAudio, checkFfmpegAvailable, getAudioDuration, WhisperError, cancelTranscription, isTranscribing, FFMPEG_MISSING_MESSAGE, fileExists } from '../services/whisper.js';
import { mergeSingleStream, mergeDualStream, renderTranscript } from '../services/transcriptMerger.js';
import { recordCompletion, getEstimatedDuration } from '../services/performanceTracker.js';
import { getModelStatus } from '../services/modelDownloader.js';
import type { TranscriptionLanguage } from '../types.js';

const router = Router();

const upload = multer({
  dest: config.uploadsDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB ceiling for long recordings
});

const ALLOWED_LANGUAGES: TranscriptionLanguage[] = ['auto', 'en', 'ru'];

function normalizeLanguage(value: unknown): TranscriptionLanguage {
  if (typeof value === 'string' && (ALLOWED_LANGUAGES as string[]).includes(value)) {
    return value as TranscriptionLanguage;
  }
  return 'ru';
}

/// Runs the whisper transcription + merge/render pipeline for a session in
/// the background. Never awaited by the caller so the upload endpoint can
/// respond immediately with status "transcribing".
async function runTranscription(sessionId: string, audioPath: string, language: TranscriptionLanguage, boost = false) {
  let boostedPath: string | null = null;
  try {
    let inputPath: string;
    if (boost) {
      boostedPath = await boostAudio(audioPath);
      inputPath = boostedPath;
    } else {
      inputPath = await ensureWav(audioPath);
    }

    const segments = await transcribe(inputPath, language, sessionId);
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
      await recordCompletion(duration, processingTime, false);
    }

    if (duration > 0 && duration < 30) {
      await sessionManager.deleteSession(sessionId);
      return;
    }
  } catch (err) {
    const current = await sessionManager.getSession(sessionId);
    if (current?.status === 'failed') return;
    const message = err instanceof WhisperError ? err.message : (err as Error)?.message || 'Transcription failed';
    await sessionManager.updateSession(sessionId, { status: 'failed', error: message });
  } finally {
    if (boostedPath) {
      fs.unlink(boostedPath).catch(() => {});
    }
  }
}

async function runDualTranscription(
  sessionId: string,
  micPath: string,
  systemPath: string,
  language: TranscriptionLanguage,
  boost = false,
) {
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

    const [micSegments, systemSegments] = await Promise.all([
      transcribe(micInput, language, sessionId),
      transcribe(systemInput, language, sessionId),
    ]);

    const utterances = mergeDualStream(micSegments, systemSegments);

    const session = await sessionManager.getSession(sessionId);
    const startedAt = session?.createdAt ?? new Date().toISOString();
    const duration = utterances.length > 0 ? Math.max(...utterances.map((u) => u.end)) : 0;

    const transcript = renderTranscript(utterances, startedAt, duration);
    await sessionManager.writeTranscript(sessionId, transcript);

    await sessionManager.updateSession(sessionId, {
      status: 'completed',
      duration,
    });

    const completedSession = await sessionManager.getSession(sessionId);
    if (completedSession?.transcriptionStartedAt) {
      const processingTime = (Date.now() - new Date(completedSession.transcriptionStartedAt).getTime()) / 1000;
      await recordCompletion(duration, processingTime, true);
    }

    if (duration > 0 && duration < 30) {
      await sessionManager.deleteSession(sessionId);
      return;
    }
  } catch (err) {
    const current = await sessionManager.getSession(sessionId);
    if (current?.status === 'failed') return;
    const message = err instanceof WhisperError ? err.message : (err as Error)?.message || 'Transcription failed';
    await sessionManager.updateSession(sessionId, { status: 'failed', error: message });
  } finally {
    if (boostedMicPath) fs.unlink(boostedMicPath).catch(() => {});
    if (boostedSystemPath) fs.unlink(boostedSystemPath).catch(() => {});
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
router.post('/upload', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'systemAudio', maxCount: 1 },
]), async (req, res) => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  const micFile = files?.['audio']?.[0];
  if (!micFile) {
    res.status(400).json({ error: 'No audio file uploaded (expected field "audio")' });
    return;
  }

  const systemFile = files?.['systemAudio']?.[0];
  const language = normalizeLanguage(req.body?.language);
  const isDual = !!systemFile;

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

  try {
    const session = await sessionManager.createSession(
      isDual ? undefined : micFile.originalname,
      language,
      isDual,
    );
    const sessionDir = sessionManager.sessionAudioDir(session.id);

    if (isDual) {
      const micExt = path.extname(micFile.originalname) || '.wav';
      const micDest = path.join(sessionDir, `audio-mic${micExt}`);
      await fs.copyFile(micFile.path, micDest);
      await fs.unlink(micFile.path).catch(() => {});

      const sysExt = path.extname(systemFile!.originalname) || '.wav';
      const sysDest = path.join(sessionDir, `audio-system${sysExt}`);
      await fs.copyFile(systemFile!.path, sysDest);
      await fs.unlink(systemFile!.path).catch(() => {});

      const audioDur = await getAudioDuration(micDest);
      const estDur = audioDur > 0 ? await getEstimatedDuration(audioDur, true) : 0;
      const inProgress = await sessionManager.updateSession(session.id, {
        status: 'transcribing',
        transcriptionStartedAt: new Date().toISOString(),
        duration: audioDur > 0 ? audioDur : undefined,
        ...(estDur > 0 ? { estimatedDuration: estDur } : {}),
      });
      void runDualTranscription(session.id, micDest, sysDest, language);
      res.status(201).json(inProgress ?? session);
    } else {
      const ext = path.extname(micFile.originalname) || '.wav';
      const destPath = path.join(sessionDir, `audio${ext}`);
      await fs.copyFile(micFile.path, destPath);
      await fs.unlink(micFile.path).catch(() => {});

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
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'Failed to start transcription' });
  }
});

// POST /api/sessions/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  const session = await sessionManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.status !== 'transcribing') {
    res.status(400).json({ error: 'Session is not currently transcribing' });
    return;
  }
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
    const audioDur = await getAudioDuration(audioFiles.mic);
    const estDur = audioDur > 0 ? await getEstimatedDuration(audioDur, true) : 0;
    const updated = await sessionManager.updateSession(req.params.id, {
      status: 'transcribing',
      error: undefined,
      transcriptionStartedAt: new Date().toISOString(),
      duration: audioDur > 0 ? audioDur : undefined,
      ...(estDur > 0 ? { estimatedDuration: estDur } : {}),
    });
    void runDualTranscription(req.params.id, audioFiles.mic, audioFiles.system, language, !!boost);
    res.json(updated ?? session);
  } else if (audioFiles.single) {
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
  } else {
    res.status(400).json({ error: 'Audio file no longer exists for this session' });
  }
});

export async function recoverOrphanedSessions() {
  try {
    const sessions = await sessionManager.listSessions();
    for (const session of sessions) {
      if (session.status === 'transcribing' && !isTranscribing(session.id)) {
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
