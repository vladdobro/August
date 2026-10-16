import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config, WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD, WHISPER_VAD_MODEL } from '../config.js';
import { downloadToFile, isOfflineError, type DownloadProgress } from './download.js';
import { fileExists } from './whisper.js';

/// On-demand download of the CUDA whisper-cli variant (AUG-130), modelled on modelDownloader.ts.
export type CudaState = 'present' | 'downloading' | 'missing' | 'not-needed';

export interface CudaStatus {
  state: CudaState;
  binPath: string;
  percent: number;
  error: string | null;
}

const emitter = new EventEmitter();

let status: CudaStatus = {
  state: 'not-needed',
  binPath: '',
  percent: 0,
  error: null,
};

function setStatus(patch: Partial<CudaStatus>): void {
  status = { ...status, ...patch };
  emitter.emit('status', { ...status });
}

export function getCudaStatus(): CudaStatus { return { ...status }; }

export function onCudaStatus(listener: (s: CudaStatus) => void): () => void {
  emitter.on('status', listener);
  return () => emitter.off('status', listener);
}

let ensurePromise: Promise<void> | null = null;

export async function ensureWhisperCuda(): Promise<void> {
  if (config.whisperGpuEngine !== 'cuda') return;
  if (ensurePromise) return ensurePromise;
  ensurePromise = doEnsure().finally(() => { ensurePromise = null; });
  return ensurePromise;
}

/// Where a Silero VAD model may already live (CPU variant dir, dev bin root, packaged resources).
function vadCandidates(targetDir: string): string[] {
  const dirs = [
    targetDir.replace(WHISPER_CUDA_BUILD.extractedDir, 'win-x64'),
    path.join(WHISPER_BIN_ROOT, 'win-x64'),
  ];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) dirs.push(path.join(resourcesPath, 'whisper', 'bin', 'win-x64'));
  return [...new Set(dirs)].map((d) => path.join(d, WHISPER_VAD_MODEL.fileName));
}

async function doEnsure(): Promise<void> {
  const binPath = config.whisperCudaBinPath ?? config.whisperBinPath;
  if (await fileExists(binPath)) {
    config.whisperBinPath = binPath;
    setStatus({ state: 'present', binPath, error: null });
    return;
  }

  const targetDir = path.dirname(binPath);
  await fs.mkdir(targetDir, { recursive: true });

  setStatus({ state: 'downloading', binPath, percent: 0, error: null });
  console.log(`Downloading CUDA whisper-cli (${WHISPER_CUDA_BUILD.version}, ~${(WHISPER_CUDA_BUILD.sizeBytes / 1e6).toFixed(0)} MB)...`);

  const zipPath = path.join(targetDir, 'whisper-cublas.zip.part');
  const extractDir = path.join(targetDir, '.extract');
  await fs.unlink(zipPath).catch(() => {});

  let lastLoggedStep = -1;
  const onProgress = (p: DownloadProgress) => {
    setStatus({ percent: p.percent });
    const step = Math.floor(p.percent / 10);
    if (step !== lastLoggedStep) {
      lastLoggedStep = step;
      console.log(`  CUDA whisper download: ${p.percent.toFixed(0)}%`);
    }
  };

  try {
    const { sha256 } = await downloadToFile(WHISPER_CUDA_BUILD.url, zipPath, {
      expectedBytes: WHISPER_CUDA_BUILD.sizeBytes,
      offlineMessage: 'No internet connection. Cannot download the CUDA whisper-cli.',
      onProgress,
    });

    if (sha256.toLowerCase() !== WHISPER_CUDA_BUILD.sha256.toLowerCase()) {
      await fs.unlink(zipPath).catch(() => {});
      const error = `CUDA whisper checksum mismatch (expected ${WHISPER_CUDA_BUILD.sha256}, got ${sha256}). Deleted — restart to retry.`;
      console.error(error);
      setStatus({ state: 'missing', error });
      return;
    }

    // Extract the zip, then copy only the needed files from Release/.
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(extractDir, { recursive: true });

    // bsdtar ships with Windows 10+; PowerShell Expand-Archive is the fallback.
    const tarBin = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const tarResult = spawnSync(tarBin, ['-xf', zipPath, '-C', extractDir], { timeout: 120_000 });
    if (tarResult.status !== 0) {
      const quote = (p: string) => p.replace(/'/g, "''");
      const psResult = spawnSync('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(extractDir)}' -Force`,
      ], { timeout: 120_000 });
      if (psResult.status !== 0) {
        throw new Error('Failed to extract CUDA whisper zip (both tar and Expand-Archive failed)');
      }
    }

    const releaseDir = path.join(extractDir, 'Release');
    for (const entry of WHISPER_CUDA_BUILD.entries) {
      const source = path.join(releaseDir, entry);
      if (!(await fileExists(source))) {
        throw new Error(`${entry} missing inside CUDA whisper zip`);
      }
      await fs.copyFile(source, path.join(targetDir, entry));
    }

    // Copy the VAD model next to the CUDA whisper-cli (config.whisperVadModelPath defaults to that folder).
    const cudaVadPath = path.join(targetDir, WHISPER_VAD_MODEL.fileName);
    if (!(await fileExists(cudaVadPath))) {
      for (const candidate of vadCandidates(targetDir)) {
        if (await fileExists(candidate)) {
          await fs.copyFile(candidate, cudaVadPath);
          break;
        }
      }
    }

    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(zipPath).catch(() => {});

    if (!(await fileExists(binPath))) {
      throw new Error('CUDA whisper-cli missing after extraction');
    }

    config.whisperBinPath = binPath;
    config.whisperVadModelPath = path.join(targetDir, WHISPER_VAD_MODEL.fileName);
    setStatus({ state: 'present', percent: 100, error: null });
    console.log(`✔ CUDA whisper-cli ready at ${binPath}`);
  } catch (err) {
    await fs.unlink(zipPath).catch(() => {});
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    let error: string;
    if (isOfflineError(err)) {
      error = (err as Error)?.message || 'No internet connection. Cannot download the CUDA whisper-cli.';
    } else {
      error = `CUDA whisper download failed: ${(err as Error)?.message || err}. Restart to retry.`;
    }
    console.error(error);
    setStatus({ state: 'missing', error });
  }
}
