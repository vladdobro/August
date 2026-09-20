import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/src -> server -> repo root
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');

export const ENV_FILE_PATH = path.resolve(repoRoot, '.env');
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

export const WHISPER_MODEL = {
  fileName: 'ggml-large-v3-turbo-q8_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin',
  sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
  sizeBytes: 874188075,
} as const;

function defaultWhisperModelPath(): string {
  return path.resolve(repoRoot, 'whisper', 'models', WHISPER_MODEL.fileName);
}

function defaultWhisperBinPath(): string {
  return path.join(WHISPER_BIN_ROOT, whisperPlatformDir() ?? `${process.platform}-${process.arch}`, whisperBinName());
}

export interface AppConfig {
  port: number;
  whisperBinPath: string;
  whisperModelPath: string;
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
  // Metal on Apple Silicon, Vulkan on Windows x64; other platforms keep --no-gpu.
  whisperUseGpu: boolean;
  groqApiKey: string | null;
}

export const config: AppConfig = {
  port: Number(process.env.PORT) || 3001,
  whisperBinPath: process.env.WHISPER_BIN_PATH?.trim()
    ? path.resolve(process.env.WHISPER_BIN_PATH.trim())
    : defaultWhisperBinPath(),
  whisperModelPath: process.env.WHISPER_MODEL_PATH?.trim()
    ? path.resolve(process.env.WHISPER_MODEL_PATH.trim())
    : defaultWhisperModelPath(),
  dataDir: path.resolve(serverRoot, 'data'),
  sessionsDir: path.resolve(serverRoot, 'data', 'sessions'),
  uploadsDir: path.resolve(serverRoot, 'data', 'uploads'),
  capturesDir: path.resolve(serverRoot, 'data', 'captures'),
  toolsDir: path.resolve(serverRoot, 'data', 'tools'),
  wasapiHelperSourcePath: path.resolve(serverRoot, 'tools', 'wasapi-loopback', 'WasapiLoopback.cs'),
  audioteeSampleFormat: process.env.AUDIOTEE_SAMPLE_FORMAT?.trim() || null,
  whisperUseGpu:
    (process.platform === 'darwin' && process.arch === 'arm64') ||
    (process.platform === 'win32' && process.arch === 'x64'),
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
