import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  config,
  DEFAULT_LLM_MODEL_ID,
  findLlmModel,
  LLAMA_CPP_BUILDS,
  LLAMA_CPP_VERSION,
  LLAMA_CUDA_RUNTIME_DLLS,
  llamaServerBinName,
  llmCpuVariantDir,
  llmVariantDir,
  WHISPER_BIN_ROOT,
  WHISPER_CUDA_BUILD,
  whisperBinName,
  type LlmModelSpec,
  type LlmVariantDir,
} from '../config.js';
import { downloadToFile, isOfflineError, type DownloadProgress } from './download.js';
import { LLM_LOCATION_UNAVAILABLE_MESSAGE, isLlmRelocating, llmLocationAvailable } from './llmLocation.js';
import { LLAMA_VERSION_MARKER, llamaBuildInstalled, llmBinDir, llmModelPath, llmModelsDir } from './llmPaths.js';
import { setLlmDownloadStatus } from './llmStatus.js';
import { readPreferences } from './preferencesStore.js';
import { fileExists } from './whisper.js';

/// On-demand download of the opt-in local language model (AUG-162): the pinned llama-server build and the GGUF model,
/// modelled on cudaDownloader.ts / modelDownloader.ts. Nothing here runs unless `llmEnabled` is true in preferences.
export { getLlmDownloadStatus, onLlmDownloadStatus, type LlmDownloadPhase, type LlmDownloadStatus } from './llmStatus.js';

const setStatus = setLlmDownloadStatus;

/// Single source of truth for the opt-in: user-preferences.json, read on each use.
export async function readLlmSettings(): Promise<{ enabled: boolean; model: LlmModelSpec }> {
  const prefs = await readPreferences();
  const model = findLlmModel(prefs.llmModel) ?? findLlmModel(DEFAULT_LLM_MODEL_ID)!;
  return { enabled: prefs.llmEnabled === true, model };
}

/// Extracts a .zip / .tar.gz into destDir. Windows calls System32\tar.exe by absolute path (Git Bash puts GNU tar first
/// on PATH, which reads "D:\..." as host:path); Expand-Archive is the Windows zip fallback. Throws on failure.
export function extractArchive(archivePath: string, destDir: string, kind: 'zip' | 'tar.gz'): void {
  if (kind === 'tar.gz') {
    // macOS bsdtar keeps the dylib symlinks intact.
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 300_000 });
    if (result.status !== 0) throw new Error(`Failed to extract ${path.basename(archivePath)}`);
    return;
  }
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const tarResult = spawnSync(tarBin, ['-xf', archivePath, '-C', destDir], { timeout: 300_000 });
  if (tarResult.status === 0) return;
  if (process.platform !== 'win32') throw new Error(`Failed to extract ${path.basename(archivePath)}`);
  const quote = (p: string) => p.replace(/'/g, "''");
  const psResult = spawnSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${quote(archivePath)}' -DestinationPath '${quote(destDir)}' -Force`,
  ], { timeout: 300_000 });
  if (psResult.status !== 0) {
    throw new Error(`Failed to extract ${path.basename(archivePath)} (both tar and Expand-Archive failed)`);
  }
}

/// Downloads, verifies and installs one llama.cpp build into <llmRoot>/bin/<variant>/. Throws on failure; idempotent.
export async function installLlamaBuild(variant: LlmVariantDir, opts?: { onProgress?: (p: DownloadProgress) => void }): Promise<void> {
  if (await llamaBuildInstalled(config.llmRoot, variant)) return;

  const build = LLAMA_CPP_BUILDS[variant];
  const binRoot = path.join(config.llmRoot, 'bin');
  const archive = path.join(binRoot, `${variant}.download.part`);
  const extractDir = path.join(binRoot, `.extract-${variant}`);
  const variantDir = llmBinDir(config.llmRoot, variant);

  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await fs.unlink(archive).catch(() => {});
  await fs.mkdir(binRoot, { recursive: true });

  try {
    const { sha256 } = await downloadToFile(build.url, archive, {
      expectedBytes: build.sizeBytes,
      stallTimeoutMs: 120_000,
      offlineMessage: 'No internet connection. Cannot download the local language model engine.',
      onProgress: opts?.onProgress,
    });
    if (sha256.toLowerCase() !== build.sha256.toLowerCase()) {
      await fs.unlink(archive).catch(() => {});
      throw new Error(`llama-server checksum mismatch (expected ${build.sha256}, got ${sha256})`);
    }

    await fs.mkdir(extractDir, { recursive: true });
    extractArchive(archive, extractDir, build.archive);

    const srcRoot = build.rootDir ? path.join(extractDir, build.rootDir) : extractDir;
    const serverBin = path.join(srcRoot, llamaServerBinName());
    if (!(await fileExists(serverBin))) throw new Error(`${llamaServerBinName()} missing inside the downloaded archive`);

    if (variant === 'win-x64-cuda') {
      // The CUDA runtime ships with the whisper CUDA build; reuse it instead of a second ~390 MB download.
      const runtimeDir = path.dirname(config.whisperCudaBinPath ?? path.join(WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD.extractedDir, whisperBinName()));
      for (const dll of LLAMA_CUDA_RUNTIME_DLLS) {
        const source = path.join(runtimeDir, dll);
        if (!(await fileExists(source))) throw new Error('CUDA runtime not found — install the GPU engine for transcription first');
        await fs.copyFile(source, path.join(srcRoot, dll));
      }
    }

    if (process.platform !== 'win32') await fs.chmod(serverBin, 0o755);

    await fs.writeFile(path.join(srcRoot, LLAMA_VERSION_MARKER), LLAMA_CPP_VERSION, 'utf-8');
    await fs.rm(variantDir, { recursive: true, force: true });
    await fs.rename(srcRoot, variantDir);
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(archive).catch(() => {});
  }
}

async function modelPresent(model: LlmModelSpec): Promise<boolean> {
  try {
    const stat = await fs.stat(llmModelPath(config.llmRoot, model));
    return stat.isFile() && stat.size === model.sizeBytes;
  } catch {
    return false;
  }
}

/// Downloads the GGUF model with up to 3 attempts. Throws on failure (offline errors immediately).
async function installModel(model: LlmModelSpec): Promise<void> {
  if (await modelPresent(model)) return;

  const modelFile = llmModelPath(config.llmRoot, model);
  const partPath = `${modelFile}.part`;
  await fs.mkdir(llmModelsDir(config.llmRoot), { recursive: true });
  await fs.unlink(partPath).catch(() => {});

  setStatus({ downloading: true, phase: 'model', percent: 0, bytesDownloaded: 0, totalBytes: model.sizeBytes, verifying: false, error: null });
  console.log(`Downloading local language model (${model.label}, ~${(model.sizeBytes / 1e9).toFixed(2)} GB)...`);

  let lastLoggedStep = -1;
  const onProgress = (p: DownloadProgress) => {
    setStatus({ percent: p.percent, bytesDownloaded: p.bytesDownloaded, totalBytes: p.totalBytes || model.sizeBytes });
    const step = Math.floor(p.percent / 10);
    if (step !== lastLoggedStep) {
      lastLoggedStep = step;
      console.log(`  Language model download: ${p.percent.toFixed(0)}%`);
    }
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { sha256 } = await downloadToFile(model.url, partPath, {
        expectedBytes: model.sizeBytes,
        stallTimeoutMs: 300_000,
        offlineMessage: 'No internet connection. Cannot download the local language model.',
        onProgress,
      });
      setStatus({ verifying: true });
      if (sha256.toLowerCase() !== model.sha256.toLowerCase()) {
        await fs.unlink(partPath).catch(() => {});
        throw new Error(`Model checksum mismatch (expected ${model.sha256}, got ${sha256})`);
      }
      await fs.rename(partPath, modelFile);
      setStatus({ verifying: false });
      return;
    } catch (err) {
      await fs.unlink(partPath).catch(() => {});
      setStatus({ verifying: false });
      if (isOfflineError(err) || attempt >= MAX_ATTEMPTS) throw err;
      const delaySec = attempt * 5;
      console.warn(`Language model download attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(err as Error)?.message || err}. Retrying in ${delaySec}s...`);
      setStatus({ percent: 0, bytesDownloaded: 0 });
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }
}

function engineProgress(): (p: DownloadProgress) => void {
  let lastLoggedStep = -1;
  return (p) => {
    setStatus({ percent: p.percent, bytesDownloaded: p.bytesDownloaded, totalBytes: p.totalBytes });
    const step = Math.floor(p.percent / 25);
    if (step !== lastLoggedStep) {
      lastLoggedStep = step;
      console.log(`  Language model engine download: ${p.percent.toFixed(0)}%`);
    }
  };
}

let ensurePromise: Promise<void> | null = null;

/// Makes sure everything the enabled local language model needs is on disk. No-op while the feature is off. Never
/// throws — failures land on the status object and in the log. Concurrent calls share one in-flight promise.
export async function ensureLlmInstalled(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = doEnsure().finally(() => { ensurePromise = null; });
  return ensurePromise;
}

async function doEnsure(): Promise<void> {
  try {
    const settings = await readLlmSettings();
    if (!settings.enabled) return;
    if (isLlmRelocating()) return;
    if (!(await llmLocationAvailable())) {
      setStatus({ downloading: false, phase: null, error: LLM_LOCATION_UNAVAILABLE_MESSAGE });
      return;
    }

    if (!config.llamaServerPathOverride) {
      const cpu = llmCpuVariantDir({ platform: process.platform, arch: process.arch });
      if (!cpu) {
        setStatus({ downloading: false, phase: null, error: 'The local language model is not supported on this computer.' });
        return;
      }
      if (!(await llamaBuildInstalled(config.llmRoot, cpu))) {
        setStatus({ downloading: true, phase: 'engine', percent: 0, bytesDownloaded: 0, totalBytes: LLAMA_CPP_BUILDS[cpu].sizeBytes, verifying: false, error: null });
        console.log(`Downloading llama-server ${LLAMA_CPP_VERSION} (${cpu}, ~${(LLAMA_CPP_BUILDS[cpu].sizeBytes / 1e6).toFixed(0)} MB)...`);
        await installLlamaBuild(cpu, { onProgress: engineProgress() });
      }

      const wanted = llmVariantDir({ platform: process.platform, arch: process.arch, gpuEngine: config.whisperGpuEngine });
      if (wanted === 'win-x64-cuda' && !(await llamaBuildInstalled(config.llmRoot, wanted))) {
        setStatus({ downloading: true, phase: 'gpu-engine', percent: 0, bytesDownloaded: 0, totalBytes: LLAMA_CPP_BUILDS[wanted].sizeBytes, verifying: false, error: null });
        console.log(`Downloading CUDA llama-server ${LLAMA_CPP_VERSION} (~${(LLAMA_CPP_BUILDS[wanted].sizeBytes / 1e6).toFixed(0)} MB)...`);
        try {
          await installLlamaBuild(wanted, { onProgress: engineProgress() });
        } catch (err) {
          console.warn(`⚠ CUDA llama-server unavailable (${(err as Error)?.message || err}) — the local model runs on CPU.`);
        }
      }
    }

    await installModel(settings.model);
    console.log(`✔ Local language model ready (${settings.model.label})`);
    setStatus({ downloading: false, phase: null, verifying: false, error: null });
  } catch (err) {
    const error = isOfflineError(err)
      ? ((err as Error)?.message || 'No internet connection. Cannot download the local language model.')
      : `Local model download failed: ${(err as Error)?.message || err}`;
    console.error(error);
    setStatus({ downloading: false, phase: null, verifying: false, error });
  }
}

/// 'ready' when a llama-server (custom or the pinned CPU build) and the selected model file are both present.
export async function llmInstallState(model: LlmModelSpec): Promise<'missing' | 'ready'> {
  if (!(await llmLocationAvailable())) return 'missing';
  let engineReady: boolean;
  if (config.llamaServerPathOverride) {
    engineReady = await fileExists(config.llamaServerPathOverride);
  } else {
    const cpu = llmCpuVariantDir({ platform: process.platform, arch: process.arch });
    engineReady = cpu ? await llamaBuildInstalled(config.llmRoot, cpu) : false;
  }
  return engineReady && (await modelPresent(model)) ? 'ready' : 'missing';
}
