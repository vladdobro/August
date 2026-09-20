import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';

import { config, whisperPlatformDir } from './config.js';
import healthRouter from './routes/health.js';
import sessionsRouter, { recoverOrphanedSessions } from './routes/sessions.js';
import setupRouter from './routes/setup.js';
import praxisRouter from './routes/praxis.js';
import preferencesRouter from './routes/preferences.js';
import captureRouter from './routes/capture.js';
import { setupLiveTranscription } from './services/liveTranscription.js';
import { checkFfmpegAvailable, FFMPEG_MISSING_MESSAGE, fileExists } from './services/whisper.js';
import { ensureWhisperModel } from './services/modelDownloader.js';
import { cleanupOrphanedCaptures } from './services/systemCapture.js';
import { migrateLegacyPreferences } from './services/preferencesStore.js';

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
  if (!(await checkFfmpegAvailable())) {
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
  await runPreflightChecks();

  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api', healthRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/praxis', praxisRouter);
  app.use('/api/preferences', preferencesRouter);
  app.use('/api/capture', captureRouter);

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
  const gpuBackend = process.platform === 'darwin' ? 'Metal' : 'Vulkan';
  console.log(`  Platform: ${process.platform}-${process.arch} (GPU: ${config.whisperUseGpu ? gpuBackend : 'off'})`);
  console.log(`  Live transcription: ws://localhost:${port}/api/live-transcribe`);
  console.log(`  System capture: GET /api/capture/capabilities (loopback only)`);
  console.log(`  Groq API: ${config.groqApiKey ? 'configured' : 'not configured (live mode uses local whisper only)'}`);

  void ensureWhisperModel();

  return {
    port,
    httpServer,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve()))),
  };
}
