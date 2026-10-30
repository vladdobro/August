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

export function ytDlpBinName(): string {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

export type YtDlpSource = 'env' | 'bundled' | 'path';

export interface YtDlpPaths {
  path: string;
  source: YtDlpSource;
}

/// Resolves the yt-dlp executable used for YouTube/platform links (AUG-149). Precedence:
///  1. YTDLP_PATH env — an explicit yt-dlp executable.
///  2. Bundled build — yt-dlp next to whisper-cli (whisper/bin/<platform>/ in the repo, resources/whisper/bin/<platform>/
///     when packaged), downloaded by `npm run setup`.
///  3. PATH fallback — bare `yt-dlp`, so dev machines with `winget install yt-dlp` / `brew install yt-dlp` keep working.
/// Pure: every input is injected so the precedence is unit-testable without touching the file system.
export function resolveYtDlpPath(input: {
  envPath: string | undefined;
  bundledDirs: string[];
  exists: (p: string) => boolean;
}): YtDlpPaths {
  const envPath = input.envPath?.trim();
  if (envPath) return { path: path.resolve(envPath), source: 'env' };
  for (const dir of input.bundledDirs) {
    const candidate = path.join(dir, ytDlpBinName());
    if (input.exists(candidate)) return { path: candidate, source: 'bundled' };
  }
  return { path: ytDlpBinName(), source: 'path' };
}

/// YTDLP_MAX_DURATION_HOURS (AUG-149): longest platform video accepted before download. Unset/invalid → 4 h.
export function parseMaxDurationHours(raw: string | undefined): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value : 4;
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

/// llama.cpp release (AUG-162) for the opt-in local language model: llama-server is started on demand and stopped after idle.
/// Bump the tag, every sha256 and sizeBytes together (sha256 = the GitHub release asset digest).
export const LLAMA_CPP_VERSION = 'b11630';
export type LlmVariantDir = WhisperPlatformDir | 'win-x64-cuda';
export interface LlamaCppBuild {
  asset: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  archive: 'zip' | 'tar.gz';
  /// Top-level folder inside the archive; null = files sit at the archive root.
  rootDir: string | null;
}

function llamaCppBuild(asset: string, sha256: string, sizeBytes: number, archive: 'zip' | 'tar.gz', rootDir: string | null): LlamaCppBuild {
  return {
    asset,
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/${asset}`,
    sha256,
    sizeBytes,
    archive,
    rootDir,
  };
}

export const LLAMA_CPP_BUILDS: Record<LlmVariantDir, LlamaCppBuild> = {
  'win-x64': llamaCppBuild(
    `llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
    '82463bff7b42c41e8dc934202fb60ba28e1120c04264484b8d349b4a5958190d', 19563017, 'zip', null,
  ),
  'win-x64-cuda': llamaCppBuild(
    `llama-${LLAMA_CPP_VERSION}-bin-win-cuda-12.4-x64.zip`,
    'e260e0f3dbc93928205005b91a69e3ab037519ea7b0aac3c73d8faa38a5c69ae', 265267891, 'zip', null,
  ),
  'darwin-arm64': llamaCppBuild(
    `llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.tar.gz`,
    '5ae1715475f0e1c9018cc6e2a3329c4fe7c2d6e9c1a848a7de4b239d50558c24', 12166481, 'tar.gz', `llama-${LLAMA_CPP_VERSION}`,
  ),
  'darwin-x64': llamaCppBuild(
    `llama-${LLAMA_CPP_VERSION}-bin-macos-x64.tar.gz`,
    'f5dcb0714fd50a2cb746b01807840316eae35a736ca875fa3349f4141c1b6822', 11658324, 'tar.gz', `llama-${LLAMA_CPP_VERSION}`,
  ),
};

/// CUDA 12.4 runtime DLLs the CUDA llama-server needs; copied from the whisper CUDA build instead of a second ~390 MB download.
export const LLAMA_CUDA_RUNTIME_DLLS = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'] as const;

export type LlmModelId = 'qwen2.5-1.5b-instruct-q4km' | 'qwen2.5-3b-instruct-q4km';
export interface LlmModelSpec {
  id: LlmModelId;
  label: string;
  quality: 'basic' | 'better';
  fileName: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  /// Approximate RAM/VRAM while the model is loaded.
  ramBytes: number;
}

export const LLM_MODELS: readonly LlmModelSpec[] = [
  {
    id: 'qwen2.5-1.5b-instruct-q4km',
    label: 'Qwen2.5 1.5B',
    quality: 'basic',
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    sizeBytes: 1117320736,
    ramBytes: 2_000_000_000,
  },
  {
    id: 'qwen2.5-3b-instruct-q4km',
    label: 'Qwen2.5 3B',
    quality: 'better',
    fileName: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    sha256: '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d',
    sizeBytes: 2104932768,
    ramBytes: 3_000_000_000,
  },
];

/// Remembered location of the local language model files (AUG-162 follow-up): <dataDir>/llm-location.json = { "root": "<abs path>" }.
/// Kept apart from user-preferences.json so "Reset to Defaults" never forgets where GBs of model files live.
export const LLM_LOCATION_FILE_NAME = 'llm-location.json';
/// Subfolder created inside the folder the user picks, so a drive root or Desktop is never filled with loose files.
export const LLM_ROOT_SUBFOLDER = 'August LLM';

/// Where the local LLM files live. Precedence: LLM_ROOT env (pinned) → the remembered root from llm-location.json →
/// <dataDir>/llm. Pure: every input is injected so the precedence is unit-testable without touching the file system.
export function resolveLlmRoot(input: { envRoot: string | undefined; persistedRoot: unknown; dataDir: string }): { root: string; pinned: boolean; isDefault: boolean } {
  const defaultRoot = path.join(input.dataDir, 'llm');
  const envRoot = input.envRoot?.trim();
  if (envRoot) return { root: path.resolve(envRoot), pinned: true, isDefault: false };
  if (typeof input.persistedRoot === 'string' && input.persistedRoot.trim() && path.isAbsolute(input.persistedRoot)) {
    const root = path.resolve(input.persistedRoot);
    return { root, pinned: false, isDefault: root === defaultRoot };
  }
  return { root: defaultRoot, pinned: false, isDefault: true };
}

export const DEFAULT_LLM_MODEL_ID: LlmModelId = 'qwen2.5-1.5b-instruct-q4km';

export function findLlmModel(id: unknown): LlmModelSpec | null {
  return LLM_MODELS.find((m) => m.id === id) ?? null;
}

/// Minutes of inactivity after which llama-server is stopped (AUG-162).
export const LLM_IDLE_SHUTDOWN_MINUTES = 10;
export const LLM_CONTEXT_SIZE = 4096;

export function llamaServerBinName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/// Which llama.cpp build to run: CUDA on Windows x64 when the whisper engine is cuda, else the platform CPU/Metal build; null = unsupported.
export function llmVariantDir(input: { platform: NodeJS.Platform; arch: string; gpuEngine: GpuEngine }): LlmVariantDir | null {
  if (input.platform === 'win32' && input.arch === 'x64') return input.gpuEngine === 'cuda' ? 'win-x64-cuda' : 'win-x64';
  return llmCpuVariantDir(input);
}

/// Same as llmVariantDir but never the CUDA build (the always-available fallback).
export function llmCpuVariantDir(input: { platform: NodeJS.Platform; arch: string }): WhisperPlatformDir | null {
  if (input.platform === 'win32' && input.arch === 'x64') return 'win-x64';
  if (input.platform === 'darwin' && input.arch === 'arm64') return 'darwin-arm64';
  if (input.platform === 'darwin' && input.arch === 'x64') return 'darwin-x64';
  return null;
}

/// LLM_GPU_LAYERS: non-negative integer → that value; blank/invalid → null.
export function parseLlmGpuLayers(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return null;
  return Number(text);
}

/// LLM_IDLE_MINUTES: positive number; blank/invalid → LLM_IDLE_SHUTDOWN_MINUTES.
export function parseLlmIdleMinutes(raw: string | undefined): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value : LLM_IDLE_SHUTDOWN_MINUTES;
}

export function parseGpuEngine(raw: string | undefined): GpuEngine {
  const value = raw?.trim().toLowerCase();
  if (value === 'cuda') return 'cuda';
  return 'cpu';
}

function readPersistedGpuEngine(): GpuEngine {
  const envOverride = process.env.WHISPER_GPU_ENGINE?.trim();
  if (envOverride) return parseGpuEngine(envOverride);
  try {
    const prefsPath = path.join(dataDir, 'user-preferences.json');
    const raw = fs.readFileSync(prefsPath, 'utf-8');
    const prefs = JSON.parse(raw);
    if (prefs.gpuEngine === 'cuda' || prefs.gpuEngine === 'cpu') return prefs.gpuEngine;
  } catch {
    // file doesn't exist or is invalid
  }
  // No in-app choice yet: the installer's choice is the default. Electron main passes %APPDATA%/August/gpu-engine
  // as WHISPER_GPU_ENGINE_DEFAULT; unlike WHISPER_GPU_ENGINE it does not pin the engine (AUG-140).
  return parseGpuEngine(process.env.WHISPER_GPU_ENGINE_DEFAULT);
}

function readPersistedLlmRoot(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, LLM_LOCATION_FILE_NAME), 'utf-8')).root;
  } catch {
    return undefined;
  }
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
  const gpuEngine = readPersistedGpuEngine();
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
  // yt-dlp for platform links (AUG-149): YTDLP_PATH env → bundled next to whisper-cli → PATH.
  ytDlpPath: string;
  ytDlpSource: YtDlpSource;
  // Longest platform video accepted before downloading (YTDLP_MAX_DURATION_HOURS, default 4 h), in seconds.
  ytDlpMaxDurationSec: number;
  // WHISPER_USE_GPU override (AUG-116): true/false pins the mode, null = platform default (Metal on Apple Silicon,
  // Vulkan on Windows x64, --no-gpu elsewhere) with automatic CPU fallback. Effective mode: services/gpuBackend.ts.
  whisperGpuOverride: boolean | null;
  // Active whisper engine (AUG-130/136/140): WHISPER_GPU_ENGINE env (pinned) → gpuEngine in user-preferences.json → WHISPER_GPU_ENGINE_DEFAULT (installer choice) → 'cpu'.
  whisperGpuEngine: GpuEngine;
  // Where the CUDA binary should live (set by Electron main, or derived from WHISPER_BIN_ROOT in dev).
  // whisperBinPath may temporarily point to the CPU variant while CUDA downloads.
  whisperCudaBinPath: string | null;
  groqApiKey: string | null;
  // Opt-in local language model (AUG-162): LLM_ROOT env (pinned) → <dataDir>/llm-location.json → <dataDir>/llm (bin/<variant>/ + models/).
  // Mutable at runtime: services/llmLocation.ts reassigns it after the files were moved to a folder chosen in Settings.
  llmRoot: string;
  // True when LLM_ROOT pins the root: Settings shows it read-only and POST /api/llm/location answers 409.
  llmRootPinned: boolean;
  // LLAMA_SERVER_PATH: a custom llama-server executable (e.g. a Vulkan build); null = the pinned build in llmRoot.
  llamaServerPathOverride: string | null;
  // LLM_GPU_LAYERS: pins the GPU offload layer count; null = automatic (see services/llmPaths.ts).
  llmGpuLayersOverride: number | null;
  // LLM_IDLE_MINUTES (default 10): idle time after which llama-server is stopped, in milliseconds.
  llmIdleShutdownMs: number;
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

// With the CUDA engine both whisper dirs are win-x64-cuda, but setup puts yt-dlp only in the CPU platform dir — search it too.
const cpuPlatformBinDir = path.join(WHISPER_BIN_ROOT, whisperPlatformDir() ?? `${process.platform}-${process.arch}`);
const ytDlpPaths = resolveYtDlpPath({
  envPath: process.env.YTDLP_PATH,
  bundledDirs: [...new Set([path.dirname(whisperBinPath), path.dirname(defaultWhisperBinPath()), cpuPlatformBinDir])],
  exists: (filePath) => fs.existsSync(filePath),
});

const llmRootInfo = resolveLlmRoot({ envRoot: process.env.LLM_ROOT, persistedRoot: readPersistedLlmRoot(), dataDir });

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
  ytDlpPath: ytDlpPaths.path,
  ytDlpSource: ytDlpPaths.source,
  ytDlpMaxDurationSec: parseMaxDurationHours(process.env.YTDLP_MAX_DURATION_HOURS) * 3600,
  whisperGpuOverride: parseGpuOverride(process.env.WHISPER_USE_GPU),
  whisperGpuEngine: readPersistedGpuEngine(),
  whisperCudaBinPath: process.env.WHISPER_CUDA_BIN_PATH?.trim()
    ? path.resolve(process.env.WHISPER_CUDA_BIN_PATH.trim())
    : (readPersistedGpuEngine() === 'cuda'
      ? path.join(WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD.extractedDir, whisperBinName())
      : null),
  groqApiKey: process.env.GROQ_API_KEY?.trim() || null,
  llmRoot: llmRootInfo.root,
  llmRootPinned: llmRootInfo.pinned,
  llamaServerPathOverride: process.env.LLAMA_SERVER_PATH?.trim() ? path.resolve(process.env.LLAMA_SERVER_PATH.trim()) : null,
  llmGpuLayersOverride: parseLlmGpuLayers(process.env.LLM_GPU_LAYERS),
  llmIdleShutdownMs: parseLlmIdleMinutes(process.env.LLM_IDLE_MINUTES) * 60_000,
};

/// The default local LLM root, <dataDir>/llm.
export function defaultLlmRoot(): string {
  return path.join(dataDir, 'llm');
}

export const AUDIO_BOOST = {
  highpassFreq: 100,
  lowpassFreq: 4000,
  volumeGain: 5.0,
  loudnormI: -16,
  loudnormTP: -1.5,
  loudnormLRA: 11,
  sampleRate: 16000,
} as const;
