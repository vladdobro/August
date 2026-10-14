import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/src -> server -> repo root
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');

// Writable runtime root. AUGUST_DATA_DIR (set by the Electron shell to <userData>/data) relocates every
// machine-specific file — sessions, uploads, captures, compiled tools, preferences, perf stats and the .env
// written by POST /api/config/groq-key — off the read-only install directory. Unset = repo layout (server/data).
const dataDirOverride = process.env.AUGUST_DATA_DIR?.trim();
const dataDir = dataDirOverride ? path.resolve(dataDirOverride) : path.resolve(serverRoot, 'data');

export const ENV_FILE_PATH = dataDirOverride ? path.join(dataDir, '.env') : path.resolve(repoRoot, '.env');
dotenv.config({ path: ENV_FILE_PATH });

export const WHISPER_CPP_VERSION = '1.8.4';
export const WHISPER_BIN_ROOT = path.resolve(repoRoot, 'whisper', 'bin');
export const WHISPER_BUILD_DIR = path.resolve(repoRoot, 'whisper', '.build');

export type WhisperPlatformDir = 'win-x64' | 'darwin-arm64' | 'darwin-x64';

/// Maps process.platform + process.arch to whisper/bin/<dir>; null when the
/// current platform/arch combination isn't supported (e.g. Linux).
export function whisperPlatformDir(): WhisperPlatformDir | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64';
  return null;
}

export function whisperBinName(): string {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

export function ffmpegBinName(tool: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${tool}.exe` : tool;
}

export type FfmpegSource = 'env' | 'bundled' | 'path';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
  source: FfmpegSource;
}

/// Resolves the ffmpeg + ffprobe executables (AUG-115). Precedence:
///  1. FFMPEG_PATH env — an explicit ffmpeg executable; ffprobe is taken from the same directory when present.
///  2. Bundled build — ffmpeg next to whisper-cli (whisper/bin/<platform>/ in the repo, resources/whisper/bin/<platform>/
///     when packaged), installed by `npm run setup`.
///  3. PATH fallback — bare `ffmpeg` / `ffprobe`, so dev machines with a system install keep working.
/// Pure: every input is injected so the precedence is unit-testable without touching the file system.
export function resolveFfmpegPaths(input: {
  envPath: string | undefined;
  bundledDirs: string[];
  exists: (filePath: string) => boolean;
  binName?: (tool: 'ffmpeg' | 'ffprobe') => string;
}): FfmpegPaths {
  const binName = input.binName ?? ffmpegBinName;
  const withSiblingProbe = (ffmpeg: string, source: FfmpegSource): FfmpegPaths => {
    const probe = path.join(path.dirname(ffmpeg), binName('ffprobe'));
    return { ffmpeg, ffprobe: input.exists(probe) ? probe : binName('ffprobe'), source };
  };
  const envPath = input.envPath?.trim();
  if (envPath) return withSiblingProbe(path.resolve(envPath), 'env');
  for (const dir of input.bundledDirs) {
    const candidate = path.join(dir, binName('ffmpeg'));
    if (input.exists(candidate)) return withSiblingProbe(candidate, 'bundled');
  }
  return { ffmpeg: binName('ffmpeg'), ffprobe: binName('ffprobe'), source: 'path' };
}

export type AudioteeSource = 'env' | 'bundled' | 'path';

export interface AudioteePaths {
  path: string;
  source: AudioteeSource;
}

/// Resolves the audiotee Core Audio tap helper (AUG-118). Precedence:
///  1. AUDIOTEE_PATH env — an explicit audiotee executable.
///  2. Bundled build — audiotee next to whisper-cli (whisper/bin/<platform>/ in the repo, resources/whisper/bin/<platform>/
///     when packaged), built by `npm run setup`.
///  3. PATH fallback — bare `audiotee`, so dev machines with a manual install keep working.
/// Pure: every input is injected so the precedence is unit-testable without touching the file system.
export function resolveAudioteePath(input: {
  envPath: string | undefined;
  bundledDirs: string[];
  exists: (p: string) => boolean;
}): AudioteePaths {
  const envPath = input.envPath?.trim();
  if (envPath) return { path: path.resolve(envPath), source: 'env' };
  for (const dir of input.bundledDirs) {
    const candidate = path.join(dir, 'audiotee');
    if (input.exists(candidate)) return { path: candidate, source: 'bundled' };
  }
  return { path: 'audiotee', source: 'path' };
}

/// WHISPER_USE_GPU=0|1 (also true/false, on/off, yes/no) pins the whisper GPU mode and disables the runtime
/// probe + automatic CPU fallback (AUG-116). Unset, blank or unrecognised → null → platform default with fallback.
export function parseGpuOverride(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
  return null;
}

export const WHISPER_MODEL = {
  fileName: 'ggml-large-v3-turbo-q8_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin',
  sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
  sizeBytes: 874188075,
} as const;

/// Silero VAD model for whisper.cpp `--vad` (AUG-125): non-speech regions are skipped instead of decoded. ~0.9 MB, so
/// `npm run setup` places it next to whisper-cli in whisper/bin/<platform>/ and both electron-builder extraResources
/// (mac + win) ship it without config changes.
export const WHISPER_VAD_MODEL = {
  fileName: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
  sizeBytes: 885098,
} as const;

export type GpuEngine = 'cpu' | 'cuda';

/// CUDA variant of whisper-cli (AUG-130), downloaded on demand (dev: npm run setup, packaged: server at first launch).
export const WHISPER_CUDA_BUILD = {
  version: WHISPER_CPP_VERSION,
  url: `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-cublas-12.4.0-bin-x64.zip`,
  sha256: 'b07cff4e59831b227896018facbb6334907bf324a342c84597c44f087823d252',
  sizeBytes: 457024596,
  extractedDir: 'win-x64-cuda',
  entries: [
    'whisper-cli.exe', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll',
    'ggml-cuda.dll', 'whisper.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll',
  ],
} as const;

export function parseGpuEngine(raw: string | undefined): GpuEngine {
  const value = raw?.trim().toLowerCase();
  if (value === 'cuda') return 'cuda';
  return 'cpu';
}

/// Post-recording decoding parameters (AUG-125), ported from SplitVox: greedy decoding (beam search was 1.6-3.4x
/// slower with no quality gain), flash attention left at whisper-cli's default (on).
export const WHISPER_DECODING = {
  beamSize: 1,
  bestOf: 1,
} as const;

function defaultWhisperModelPath(): string {
  return path.resolve(repoRoot, 'whisper', 'models', WHISPER_MODEL.fileName);
}

function defaultWhisperBinPath(): string {
  const gpuEngine = parseGpuEngine(process.env.WHISPER_GPU_ENGINE);
  const dir = gpuEngine === 'cuda' && process.platform === 'win32'
    ? WHISPER_CUDA_BUILD.extractedDir
    : (whisperPlatformDir() ?? `${process.platform}-${process.arch}`);
  return path.join(WHISPER_BIN_ROOT, dir, whisperBinName());
}

export interface AppConfig {
  port: number;
  whisperBinPath: string;
  whisperModelPath: string;
  // Silero VAD model (AUG-125): WHISPER_VAD_MODEL_PATH env → next to whisper-cli.
  whisperVadModelPath: string;
  // ffmpeg / ffprobe executables (AUG-115): FFMPEG_PATH env → bundled build next to whisper-cli → PATH.
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegSource: FfmpegSource;
  // Root of all runtime server data (sessions, uploads, captures, perf stats, user preferences).
  dataDir: string;
  sessionsDir: string;
  uploadsDir: string;
  // Server-side system audio captures (AUG-105) live here until a session upload claims them.
  capturesDir: string;
  // Compiled-on-demand helper binaries (AUG-112); gitignored.
  toolsDir: string;
  // C# source of the WASAPI loopback helper, committed; compiled into toolsDir with csc.exe.
  wasapiHelperSourcePath: string;
  // Explicit override (AUDIOTEE_SAMPLE_FORMAT=s16le|f32le) for the raw PCM format audiotee writes to
  // stdout. null = sniff it from a short probe of the binary's output (AUG-107, services/pcmSampleFormat.ts).
  audioteeSampleFormat: string | null;
  // audiotee Core Audio tap helper (AUG-118): AUDIOTEE_PATH env → bundled next to whisper-cli → PATH.
  audioteePath: string;
  // WHISPER_USE_GPU override (AUG-116): true/false pins the mode, null = platform default (Metal on Apple Silicon,
  // Vulkan on Windows x64, --no-gpu elsewhere) with automatic CPU fallback. Effective mode: services/gpuBackend.ts.
  whisperGpuOverride: boolean | null;
  // GPU engine chosen at install time (AUG-130): WHISPER_GPU_ENGINE=cpu|cuda.
  whisperGpuEngine: GpuEngine;
  // Where the CUDA binary should live (set by Electron main, or derived from WHISPER_BIN_ROOT in dev).
  // whisperBinPath may temporarily point to the CPU variant while CUDA downloads.
  whisperCudaBinPath: string | null;
  groqApiKey: string | null;
}

const whisperBinPath = process.env.WHISPER_BIN_PATH?.trim()
  ? path.resolve(process.env.WHISPER_BIN_PATH.trim())
  : defaultWhisperBinPath();

const ffmpegPaths = resolveFfmpegPaths({
  envPath: process.env.FFMPEG_PATH,
  bundledDirs: [...new Set([path.dirname(whisperBinPath), path.dirname(defaultWhisperBinPath())])],
  exists: (filePath) => fs.existsSync(filePath),
});

const audioteePaths = resolveAudioteePath({
  envPath: process.env.AUDIOTEE_PATH,
  bundledDirs: [...new Set([path.dirname(whisperBinPath), path.dirname(defaultWhisperBinPath())])],
  exists: (filePath) => fs.existsSync(filePath),
});

export const config: AppConfig = {
  port: Number(process.env.PORT) || 3001,
  whisperBinPath,
  whisperModelPath: process.env.WHISPER_MODEL_PATH?.trim()
    ? path.resolve(process.env.WHISPER_MODEL_PATH.trim())
    : defaultWhisperModelPath(),
  whisperVadModelPath: process.env.WHISPER_VAD_MODEL_PATH?.trim() ? path.resolve(process.env.WHISPER_VAD_MODEL_PATH.trim()) : path.join(path.dirname(whisperBinPath), WHISPER_VAD_MODEL.fileName),
  ffmpegPath: ffmpegPaths.ffmpeg,
  ffprobePath: ffmpegPaths.ffprobe,
  ffmpegSource: ffmpegPaths.source,
  dataDir,
  sessionsDir: path.join(dataDir, 'sessions'),
  uploadsDir: path.join(dataDir, 'uploads'),
  capturesDir: path.join(dataDir, 'captures'),
  toolsDir: path.join(dataDir, 'tools'),
  wasapiHelperSourcePath: path.resolve(serverRoot, 'tools', 'wasapi-loopback', 'WasapiLoopback.cs'),
  audioteeSampleFormat: process.env.AUDIOTEE_SAMPLE_FORMAT?.trim() || null,
  audioteePath: audioteePaths.path,
  whisperGpuOverride: parseGpuOverride(process.env.WHISPER_USE_GPU),
  whisperGpuEngine: parseGpuEngine(process.env.WHISPER_GPU_ENGINE),
  whisperCudaBinPath: process.env.WHISPER_CUDA_BIN_PATH?.trim()
    ? path.resolve(process.env.WHISPER_CUDA_BIN_PATH.trim())
    : (parseGpuEngine(process.env.WHISPER_GPU_ENGINE) === 'cuda'
      ? path.join(WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD.extractedDir, whisperBinName())
      : null),
  groqApiKey: process.env.GROQ_API_KEY?.trim() || null,
};

export const AUDIO_BOOST = {
  highpassFreq: 100,
  lowpassFreq: 4000,
  volumeGain: 5.0,
  loudnormI: -16,
  loudnormTP: -1.5,
  loudnormLRA: 11,
  sampleRate: 16000,
} as const;
