import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import { config } from './config.js';
import healthRouter from './routes/health.js';
import sessionsRouter, { recoverOrphanedSessions } from './routes/sessions.js';
import { setupLiveTranscription } from './services/liveTranscription.js';
import setupRouter from './routes/setup.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(config.sessionsDir, { recursive: true });
  await fs.mkdir(config.uploadsDir, { recursive: true });
}

async function main() {
  await ensureDataDirs();
  await recoverOrphanedSessions();

  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api', healthRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/setup', setupRouter);

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

  httpServer.listen(config.port, () => {
    console.log(`August server listening on http://localhost:${config.port}`);
    if (isDev) {
      console.log(`  Dev mode: open http://127.0.0.1:5173 for the latest UI`);
    }
    console.log(`  Sessions dir: ${config.sessionsDir}`);
    console.log(`  Whisper binary: ${config.whisperBinPath}`);
    console.log(`  Whisper model: ${config.whisperModelPath}`);
    console.log(`  Live transcription: ws://localhost:${config.port}/api/live-transcribe`);
  });
}

main().catch((err) => {
  console.error('Failed to start August server:', err);
  process.exit(1);
});
