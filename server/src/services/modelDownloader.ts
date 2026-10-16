import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config, WHISPER_MODEL } from '../config.js';
import { downloadToFile, isOfflineError, type DownloadProgress } from './download.js';

export type ModelState = 'present' | 'downloading' | 'missing';

export interface ModelStatus {
  state: ModelState;
  modelPath: string;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  verifying: boolean;
  error: string | null;
}

const emitter = new EventEmitter();

let status: ModelStatus = {
  state: 'missing',
  modelPath: config.whisperModelPath,
  percent: 0,
  bytesDownloaded: 0,
  totalBytes: 0,
  verifying: false,
  error: null,
};

function setStatus(patch: Partial<ModelStatus>): void {
  status = { ...status, ...patch };
  emitter.emit('status', { ...status });
}

export function getModelStatus(): ModelStatus {
  return { ...status };
}

export function onModelStatus(listener: (s: ModelStatus) => void): () => void {
  emitter.on('status', listener);
  return () => emitter.off('status', listener);
}

let ensurePromise: Promise<void> | null = null;

/// Ensures the default whisper model is present, downloading it on first
/// server start (and verifying its checksum) when missing. Never throws —
/// failures are recorded on the status object and logged. Safe to call
/// concurrently; concurrent calls share the same in-flight promise.
export async function ensureWhisperModel(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = doEnsureWhisperModel().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

async function doEnsureWhisperModel(): Promise<void> {
  const modelPath = config.whisperModelPath;
  const partPath = `${modelPath}.part`;

  // An interrupted download from a previous run is deleted and retried on
  // this startup rather than resumed.
  await fs.unlink(partPath).catch(() => {});

  const exists = await fs.access(modelPath).then(() => true).catch(() => false);
  if (exists) {
    setStatus({ state: 'present', modelPath, error: null });
    return;
  }

  if (path.basename(modelPath) !== WHISPER_MODEL.fileName) {
    const error = `Whisper model not found at "${modelPath}". Auto-download only supports the default ${WHISPER_MODEL.fileName}; download your custom model manually.`;
    console.error(error);
    setStatus({ state: 'missing', modelPath, error });
    return;
  }

  const totalBytes = WHISPER_MODEL.sizeBytes;
  setStatus({
    state: 'downloading',
    modelPath,
    percent: 0,
    bytesDownloaded: 0,
    totalBytes,
    verifying: false,
    error: null,
  });
  console.log(`Downloading whisper model (${WHISPER_MODEL.fileName}, ~${(totalBytes / 1e9).toFixed(2)} GB)...`);

  let lastLoggedStep = -1;
  const onProgress = (p: DownloadProgress) => {
    setStatus({ percent: p.percent, bytesDownloaded: p.bytesDownloaded, totalBytes: p.totalBytes || totalBytes });
    const step = Math.floor(p.percent / 10);
    if (step !== lastLoggedStep) {
      lastLoggedStep = step;
      console.log(`  Model download: ${p.percent.toFixed(0)}%`);
    }
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { sha256 } = await downloadToFile(WHISPER_MODEL.url, partPath, {
        expectedBytes: totalBytes,
        stallTimeoutMs: 300_000,
        offlineMessage: 'No internet connection. Cannot download the whisper model.',
        onProgress,
      });

      setStatus({ verifying: true });
      const expected = WHISPER_MODEL.sha256.toLowerCase();
      const actual = sha256.toLowerCase();
      if (actual !== expected) {
        await fs.unlink(partPath).catch(() => {});
        const error = `Model checksum mismatch (expected ${expected}, got ${actual}). The corrupted file was deleted — restart the server to retry.`;
        console.error(error);
        setStatus({ state: 'missing', verifying: false, error });
        return;
      }

      await fs.rename(partPath, modelPath);
      setStatus({ state: 'present', percent: 100, verifying: false, error: null });
      console.log(`✔ Whisper model ready at ${modelPath}`);
      return;
    } catch (err) {
      await fs.unlink(partPath).catch(() => {});
      if (isOfflineError(err)) {
        const error = (err as Error)?.message || 'No internet connection. Cannot download the whisper model.';
        console.error(`Model download: ${error}`);
        setStatus({ state: 'missing', verifying: false, error });
        return;
      }
      const msg = (err as Error)?.message || String(err);
      if (attempt < MAX_ATTEMPTS) {
        const delaySec = attempt * 5;
        console.warn(`Model download attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}. Retrying in ${delaySec}s...`);
        setStatus({ error: `Download interrupted, retrying (${attempt}/${MAX_ATTEMPTS})...`, percent: 0, bytesDownloaded: 0 });
        await new Promise(r => setTimeout(r, delaySec * 1000));
        continue;
      }
      const error = `Model download failed after ${MAX_ATTEMPTS} attempts: ${msg}. The incomplete file was deleted — restart the server to retry.`;
      console.error(error);
      setStatus({ state: 'missing', verifying: false, error });
    }
  }
}
