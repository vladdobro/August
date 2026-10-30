import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';

import { config, whisperPlatformDir } from './config.js';
import healthRouter from './routes/health.js';
import engineRouter from './routes/engine.js';
import sessionsRouter, { recoverOrphanedSessions } from './routes/sessions.js';
import setupRouter from './routes/setup.js';
import praxisRouter from './routes/praxis.js';
import preferencesRouter from './routes/preferences.js';
import captureRouter from './routes/capture.js';
import llmRouter from './routes/llm.js';
import groqTextRouter from './routes/groqText.js';
import { setupLiveTranscription } from './services/liveTranscription.js';
import { checkFfmpegAvailable, FFMPEG_MISSING_MESSAGE, fileExists, probeGpuBackend } from './services/whisper.js';
import { gpuState } from './services/gpuBackend.js';
import { ensureWhisperCuda } from './services/cudaDownloader.js';
import { ensureWhisperModel } from './services/modelDownloader.js';
import { cleanupOrphanedCaptures, detectCapabilities } from './services/systemCapture.js';
import { migrateLegacyPreferences } from './services/preferencesStore.js';
import { ensureLlmInstalled } from './services/llmInstaller.js';
import { cleanupOrphanedLlmServer, killLlmServerSync, stopLlmServer } from './services/llmServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(config.sessionsDir, { recursive: true });
  await fs.mkdir(config.uploadsDir, { recursive: true });
  await fs.mkdir(config.capturesDir, { recursive: true });
}

async function runPreflightChecks(): Promise<void> {
  if (!whisperPlatformDir()) {
    console.warn(`⚠ Unsupported platform ${process.platform}-${process.arch}. Supported: Windows x64, macOS arm64/x64.`);
  }
  if (await checkFfmpegAvailable()) {
    console.log(`ffmpeg: ${config.ffmpegPath} (${config.ffmpegSource})`);
  } else {
    console.error(FFMPEG_MISSING_MESSAGE);
  }
  if (!(await fileExists(config.whisperBinPath))) {
    console.error(`❌ whisper-cli not found at ${config.whisperBinPath}. Run: npm run setup`);
  }
}

export interface StartServerOptions {
  /// Overrides config.port (PORT env, default 3001). 0 lets the OS pick a free port — the Electron shell uses that.
  port?: number;
}

export interface RunningServer {
  port: number;
  httpServer: Server;
  close(): Promise<void>;
}

/// Boots the full August HTTP + WebSocket server and resolves once it is listening.
/// Both the CLI entry (index.ts) and the Electron main process (electron/src/main.ts) call this, so
/// whisper-cli spawning, sessions, live transcription and system capture run unchanged inside the desktop shell.
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  await ensureDataDirs();
  await migrateLegacyPreferences();
  await recoverOrphanedSessions();
  await cleanupOrphanedCaptures();
  await cleanupOrphanedLlmServer();
  await runPreflightChecks();

  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api', healthRouter);
  app.use('/api', engineRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/praxis', praxisRouter);
  app.use('/api/preferences', preferencesRouter);
  app.use('/api/capture', captureRouter);
  app.use('/api/llm', llmRouter);
  app.use('/api/groq-text', groqTextRouter);

  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const viteUrl = 'http://127.0.0.1:5173';
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.redirect(viteUrl + req.originalUrl);
    });
  } else {
    const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(clientDist, 'index.html'), (err) => {
        if (err) next();
      });
    });
  }

  const httpServer = createServer(app);
  setupLiveTranscription(httpServer);

  const requestedPort = options.port ?? config.port;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  console.log(`August server listening on http://localhost:${port}`);
  if (isDev) {
    console.log(`  Dev mode: open http://127.0.0.1:5173 for the latest UI`);
  }
  console.log(`  Sessions dir: ${config.sessionsDir}`);
  console.log(`  Whisper binary: ${config.whisperBinPath}`);
  console.log(`  Whisper model: ${config.whisperModelPath}`);
  console.log(`  Platform: ${process.platform}-${process.arch} (whisper GPU: ${gpuState.describePolicy()})`);
  // AUG-130: CUDA download + GPU probe run after the server is listening so the UI loads immediately.
  // The probe re-runs after the download finishes so /api/health reports the correct backend.
  // Model download waits for CUDA to finish — running both large downloads concurrently starves the
  // model download (HuggingFace CDN) of bandwidth and triggers the stall timeout.
  void ensureWhisperCuda().then(() => probeGpuBackend()).then((backend) => {
    const reason = gpuState.fallbackReason();
    console.log(`  Whisper backend: ${backend}${reason ? ` (CPU fallback: ${reason})` : ''}`);
  }).then(() => ensureWhisperModel()).then(() => ensureLlmInstalled());
  console.log(`  Live transcription: ws://localhost:${port}/api/live-transcribe`);
  console.log(`  System capture: GET /api/capture/capabilities (loopback only)`);
  console.log('  Local LLM: GET /api/llm/status (opt-in, off until enabled in Settings)');
  console.log(`  Groq API: ${config.groqApiKey ? 'configured' : 'not configured (live mode uses local whisper only)'}`);

  void detectCapabilities();
  process.once('exit', killLlmServerSync);

  return {
    port,
    httpServer,
    close: () => stopLlmServer('server closing').catch(() => {}).then(
      () => new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve()))),
    ),
  };
}
