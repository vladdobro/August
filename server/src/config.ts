import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/src -> server -> repo root
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');

function defaultWhisperModelPath(): string {
  return path.resolve(repoRoot, 'whisper', 'models', 'ggml-large-v3-turbo.bin');
}

function defaultWhisperBinPath(): string {
  return path.resolve(repoRoot, 'whisper', 'bin', 'whisper-cli.exe');
}

export interface AppConfig {
  port: number;
  whisperBinPath: string;
  whisperModelPath: string;
  sessionsDir: string;
  uploadsDir: string;
}

export const config: AppConfig = {
  port: Number(process.env.PORT) || 3001,
  whisperBinPath: process.env.WHISPER_BIN_PATH?.trim()
    ? path.resolve(process.env.WHISPER_BIN_PATH.trim())
    : defaultWhisperBinPath(),
  whisperModelPath: process.env.WHISPER_MODEL_PATH?.trim()
    ? path.resolve(process.env.WHISPER_MODEL_PATH.trim())
    : defaultWhisperModelPath(),
  sessionsDir: path.resolve(serverRoot, 'data', 'sessions'),
  uploadsDir: path.resolve(serverRoot, 'data', 'uploads'),
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
