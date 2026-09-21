import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { config, AUDIO_BOOST } from '../config.js';
import { getModelStatus } from './modelDownloader.js';
import type { TranscriptionLanguage, TranscriptSegment, WhisperJsonOutput } from '../types.js';
import {
  classifyWhisperFailure,
  countVulkanDevices,
  describeExit,
  gpuState,
  isProcessLoadFailure,
  NO_VULKAN_DEVICE_REASON,
  runWithGpuFallback,
  type GpuBackend,
  type WhisperExit,
} from './gpuBackend.js';

export class WhisperError extends Error {
  /// Set only when whisper-cli itself ran and exited abnormally (not for pre-flight or output-file errors).
  exit?: WhisperExit;
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WhisperError';
  }
}

const WAV_EXTENSIONS = new Set(['.wav']);

export const FFMPEG_MISSING_MESSAGE = [
  '❌ ffmpeg not found. Run `npm run setup` — it downloads a bundled ffmpeg into whisper/bin/<platform>/ next to whisper-cli.',
  '   Alternatively set FFMPEG_PATH to an ffmpeg executable, or install one manually as a fallback:',
  '   macOS:   brew install ffmpeg',
  '   Windows: winget install ffmpeg',
].join('\n');

/// User-facing (session error) text when whisper-cli cannot even be loaded. With the Windows Vulkan build that is a
/// missing/broken vulkan-1.dll, which --no-gpu cannot work around (static import). `npm run setup` bundles the loader
/// (AUG-117), so on a complete install this is unreachable — reaching it means the bin folder is incomplete. Details go
/// to the server log only.
export const WHISPER_RUNTIME_MISSING_MESSAGE =
  'Transcription engine could not start: a required component is missing from the whisper install. Run `npm run setup` again (desktop app: reinstall August), then try again.';

/// Log-only line for the no-Vulkan-device case (plain language in the UI comes from /api/health gpuBackend = cpu).
const NO_VULKAN_DEVICE_LOG =
  'whisper-cli found no Vulkan device on this computer (no GPU driver with Vulkan support); transcription runs on CPU for this server run';

/// Turns an execFile ffmpeg failure into a WhisperError, using the friendlier
/// FFMPEG_MISSING_MESSAGE when the failure is the resolved ffmpeg executable not being found (ENOENT).
function ffmpegError(error: ExecFileException, stderr: string, fallbackMessage: string): WhisperError {
  if (error.code === 'ENOENT') return new WhisperError(FFMPEG_MISSING_MESSAGE, error);
  const meaningful = stderr
    .split(/\r?\n/)
    .filter(l => /^\[|^Error |error:/i.test(l.trim()))
    .join('\n')
    .trim();
  return new WhisperError(`${fallbackMessage}${meaningful || error.message}`, error);
}

const activeProcesses = new Map<string, ChildProcess[]>();

export function cancelTranscription(key: string): boolean {
  const procs = activeProcesses.get(key);
  if (!procs || procs.length === 0) return false;
  for (const child of procs) {
    child.kill();
  }
  activeProcesses.delete(key);
  return true;
}

export function isTranscribing(key: string): boolean {
  const procs = activeProcesses.get(key);
  return !!procs && procs.length > 0;
}

export function getActiveTrackingKeys(): string[] {
  return Array.from(activeProcesses.keys());
}

export async function ensureWav(audioPath: string): Promise<string> {
  const ext = path.extname(audioPath).toLowerCase();
  if (WAV_EXTENSIONS.has(ext)) return audioPath;

  const stat = await fs.stat(audioPath);
  if (stat.size === 0) {
    throw new WhisperError(`Audio file is empty (0 bytes): ${path.basename(audioPath)}`);
  }

  if (ext === '.webm') {
    const fh = await fs.open(audioPath, 'r');
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    await fh.close();
    if (buf[0] !== 0x1A || buf[1] !== 0x45 || buf[2] !== 0xDF || buf[3] !== 0xA3) {
      throw new WhisperError(
        'Audio file is corrupted (invalid WebM header). This can happen when a recording is recovered after a crash — please re-record.',
      );
    }
  }

  const baseName = path.basename(audioPath, ext);
  const wavPath = path.join(path.dirname(audioPath), `${baseName}.wav`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      config.ffmpegPath,
      ['-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath],
      { timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) reject(ffmpegError(error, stderr, 'ffmpeg conversion failed: '));
        else resolve();
      },
    );
  });
  return wavPath;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function threadCount(): number {
  const cpuCount = os.cpus()?.length ?? 1;
  return Math.max(1, cpuCount - 1);
}

const NON_ASCII = /[^\x00-\x7F]/;

/// whisper-cli.exe (the Windows whisper.cpp build) crashes with
/// STATUS_STACK_BUFFER_OVERRUN when a path argument (e.g. --model) contains
/// non-ASCII characters — verified by hand: it reproduces on this machine
/// because the Windows account name is Cyrillic, so the default
/// whisper/models/... model path crashes the binary
/// outright. Converting to the legacy Windows short (8.3) path, which is
/// pure ASCII, avoids the crash. Only shells out to cmd.exe when the path
/// actually contains non-ASCII characters, so the common case (ASCII
/// Windows profile) pays no extra cost. This 8.3 short-path conversion is a
/// cmd.exe-only concept, so it's a passthrough on macOS/Linux, which handle
/// UTF-8 paths natively.
export async function toSafePath(filePath: string): Promise<string> {
  if (process.platform !== 'win32') return filePath;
  if (!NON_ASCII.test(filePath)) return filePath;
  try {
    const shortPath = await new Promise<string>((resolve, reject) => {
      execFile(
        'cmd.exe',
        ['/c', `for %I in ("${filePath}") do @echo %~sI`],
        { windowsVerbatimArguments: true },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        },
      );
    });
    return shortPath || filePath;
  } catch {
    // If short-path resolution fails for any reason, fall back to the
    // original path rather than blocking transcription entirely.
    return filePath;
  }
}

export async function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      config.ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath],
      { timeout: 15_000 },
      (error, stdout) => {
        if (error) { resolve(0); return; }
        const sec = parseFloat(stdout.trim());
        resolve(Number.isFinite(sec) ? sec : 0);
      },
    );
  });
}

/// Runs `ffmpeg -version` against the resolved executable (config.ffmpegPath by default; the setup
/// script passes the freshly downloaded bundled binary explicitly because config was resolved at import time).
export async function checkFfmpegAvailable(ffmpegPath: string = config.ffmpegPath): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-version'], { timeout: 5000 }, (error) => {
      resolve(!error);
    });
  });
}

export async function boostAudio(audioPath: string): Promise<string> {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const baseName = path.basename(audioPath, ext);
  const boostedPath = path.join(dir, `${baseName}-boosted.wav`);

  const af = [
    `highpass=f=${AUDIO_BOOST.highpassFreq}`,
    `lowpass=f=${AUDIO_BOOST.lowpassFreq}`,
    `volume=${AUDIO_BOOST.volumeGain}`,
    `loudnorm=I=${AUDIO_BOOST.loudnormI}:TP=${AUDIO_BOOST.loudnormTP}:LRA=${AUDIO_BOOST.loudnormLRA}`,
  ].join(',');

  const [safeInput, safeOutput] = await Promise.all([
    toSafePath(audioPath),
    toSafePath(boostedPath),
  ]);

  await new Promise<void>((resolve, reject) => {
    execFile(
      config.ffmpegPath,
      ['-i', safeInput, '-af', af, '-ar', String(AUDIO_BOOST.sampleRate), '-ac', '1', '-c:a', 'pcm_s16le', '-y', safeOutput],
      { timeout: 300_000 },
      (error, _stdout, stderr) => {
        if (error) reject(ffmpegError(error, stderr, 'ffmpeg audio boost failed: '));
        else resolve();
      },
    );
  });

  return boostedPath;
}

/// One-time startup probe (AUG-116/117), Vulkan builds only: runs `whisper-cli --help`, which (a) catches the
/// process-cannot-load case (missing DLL → STATUS_DLL_NOT_FOUND) and (b) initialises ggml-vulkan, so its device banner
/// on stderr tells us whether the bundled loader found a GPU. No banner = no device = whisper-cli will run on CPU by
/// itself, so the state flips to CPU right away and /api/health reports it. Device-level Vulkan failures only surface
/// once a model is loaded, so the first real transcription is the second half of the probe (runWhisper's retry).
/// Never spawns on Metal, when WHISPER_USE_GPU pins the mode, or when the binary is absent.
export async function probeGpuBackend(): Promise<GpuBackend> {
  const state = gpuState;
  if (state.policy.locked || state.policy.nativeBackend !== 'vulkan' || !state.useGpu()) return state.backend();
  if (!(await fileExists(config.whisperBinPath))) return state.backend();
  const safeBinPath = await toSafePath(config.whisperBinPath);
  const probe = await new Promise<{ exit: WhisperExit | null; stderr: string }>((resolve) => {
    execFile(safeBinPath, ['--help'], { timeout: 10_000 }, (error, _stdout, stderr) => {
      const text = stderr ?? '';
      resolve({
        exit: error ? { code: error.code, signal: error.signal, killed: error.killed, stderr: text } : null,
        stderr: text,
      });
    });
  });
  if (!probe.exit) {
    const devices = countVulkanDevices(probe.stderr);
    if (devices === null || devices === 0) {
      state.markGpuUnusable(`startup probe: ${NO_VULKAN_DEVICE_REASON}`);
      console.log(`[gpu] ${NO_VULKAN_DEVICE_LOG}`);
    } else {
      state.markGpuConfirmed();
    }
    return state.backend();
  }
  if (classifyWhisperFailure(probe.exit) === 'gpu') {
    state.markGpuUnusable(`startup probe: ${describeExit(probe.exit)}`);
    if (isProcessLoadFailure(probe.exit)) {
      console.error(
        `[gpu] whisper-cli cannot start (${describeExit(probe.exit)}): a DLL it imports is missing. ` +
        `npm run setup bundles vulkan-1.dll next to whisper-cli, so ${path.dirname(config.whisperBinPath)} is incomplete — re-run npm run setup (desktop app: reinstall).`,
      );
    }
  } else {
    console.warn(`[gpu] startup probe inconclusive (${describeExit(probe.exit)}); keeping the GPU enabled until the first job`);
  }
  return state.backend();
}

export interface RunWhisperOptions {
  audioPath: string;
  language: string;
  outputBase: string;
  trackingKey?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/// Single entry point for every whisper-cli invocation (batch transcription
/// and live chunk transcription both go through this). Handles bin/model/
/// audio existence checks, Windows short-path conversion, spawning
/// whisper-cli with the shared flag set, process tracking (for cancellation)
/// and reading + parsing + cleaning up the JSON output file. Flags mirror
/// SplitVox's WhisperTranscriber.cs: max-context 0 (anti-loop defense), GPU per
/// gpuBackend.ts (Metal on Apple Silicon, Vulkan on Windows x64 with a one-shot
/// --no-gpu retry + process-wide CPU fallback, WHISPER_USE_GPU override), full JSON output for timestamps. Note:
/// this whisper-cli build's --output-json-full does not actually emit a
/// per-segment no_speech_prob field (verified by inspecting the binary), so
/// noSpeechProb in transcribe()'s output will typically be undefined —
/// WhisperTranscriber's "layer 2" no-speech gate degrades gracefully to a
/// no-op in that case; the hallucination blacklist and dedup logic in
/// transcriptMerger.ts are the primary defenses and are unaffected.
export async function runWhisper(opts: RunWhisperOptions): Promise<WhisperJsonOutput> {
  const { audioPath, language, outputBase, trackingKey } = opts;
  const binName = path.basename(config.whisperBinPath);

  if (!(await fileExists(config.whisperBinPath))) {
    throw new WhisperError(
      `${binName} not found at "${config.whisperBinPath}". Run \`npm run setup\` to download it (see whisper/README.md).`,
    );
  }
  if (!(await fileExists(config.whisperModelPath))) {
    const status = getModelStatus();
    if (status.state === 'downloading') {
      throw new WhisperError(`Whisper model is still downloading (${status.percent}%). Try again when it finishes.`);
    }
    throw new WhisperError(
      `Whisper model not found at "${config.whisperModelPath}". Restart the server to auto-download it (see whisper/README.md).`,
    );
  }
  if (!(await fileExists(audioPath))) {
    throw new WhisperError(`Audio file not found at "${audioPath}".`);
  }

  const outputJsonPath = `${outputBase}.json`;

  const [safeModelPath, safeBinPath, safeAudioPath, safeOutputBase] = await Promise.all([
    toSafePath(config.whisperModelPath),
    toSafePath(config.whisperBinPath),
    toSafePath(audioPath),
    toSafePath(outputBase),
  ]);

  const attempt = async (useGpu: boolean): Promise<string> => {
    const args = [
      '--model', safeModelPath,
      '--language', language || 'auto',
      '--max-context', '0',
      ...(useGpu ? [] : ['--no-gpu']),
      '--output-json-full',
      '--output-file', safeOutputBase,
      '--no-prints',
      '--threads', String(threadCount()),
      safeAudioPath,
    ];
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        safeBinPath,
        args,
        { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 64 },
        (error, _stdout, stderr) => {
          if (trackingKey) {
            const procs = activeProcesses.get(trackingKey);
            if (procs) {
              const idx = procs.indexOf(child);
              if (idx !== -1) procs.splice(idx, 1);
              if (procs.length === 0) activeProcesses.delete(trackingKey);
            }
          }
          if (error) {
            const failure = new WhisperError(`${binName} failed: ${stderr || error.message}`, error);
            failure.exit = { code: error.code, signal: error.signal, killed: error.killed, stderr: stderr ?? '' };
            reject(failure);
            return;
          }
          resolve(stderr ?? '');
        },
      );
      if (trackingKey) {
        const existing = activeProcesses.get(trackingKey) ?? [];
        existing.push(child);
        activeProcesses.set(trackingKey, existing);
      }
    });
  };

  try {
    // GPU-class failures (Vulkan) are retried once with --no-gpu and flip the process to CPU — see gpuBackend.ts.
    const stderr = await runWithGpuFallback(gpuState, attempt, {
      exitOf: (err) => (err instanceof WhisperError ? err.exit ?? null : null),
      log: (message) => console.warn(`[gpu] ${message}`),
      label: path.basename(audioPath),
    });
    // A GPU-mode run that printed no ggml-vulkan device banner ran on CPU inside whisper-cli (bundled loader, no
    // driver). Flip the state so /api/health says so and later jobs pass --no-gpu directly (AUG-117).
    if (gpuState.useGpu() && !countVulkanDevices(stderr)) {
      if (gpuState.markGpuUnusable(NO_VULKAN_DEVICE_REASON)) console.warn(`[gpu] ${NO_VULKAN_DEVICE_LOG}`);
    }
  } catch (err) {
    if (err instanceof WhisperError) {
      if (err.exit && isProcessLoadFailure(err.exit)) {
        console.error(
          `[gpu] ${binName} could not be loaded (${describeExit(err.exit)}): a DLL it imports is missing. ` +
          `npm run setup bundles vulkan-1.dll next to ${binName}, so ${path.dirname(config.whisperBinPath)} is incomplete — re-run npm run setup (desktop app: reinstall).`,
        );
        throw new WhisperError(WHISPER_RUNTIME_MISSING_MESSAGE, err);
      }
      throw err;
    }
    throw new WhisperError(`Failed to run ${binName}`, err);
  }

  try {
    const raw = await fs.readFile(outputJsonPath, 'utf-8');
    try {
      return JSON.parse(raw) as WhisperJsonOutput;
    } catch (err) {
      throw new WhisperError(`Failed to parse ${binName} JSON output`, err);
    }
  } catch (err) {
    if (err instanceof WhisperError) throw err;
    throw new WhisperError(`${binName} did not produce output at "${outputJsonPath}"`, err);
  } finally {
    // Best-effort cleanup of the temp output file; ignore failures.
    fs.unlink(outputJsonPath).catch(() => {});
  }
}

/// Runs whisper-cli against `audioPath` and returns the parsed, per-segment
/// transcript with numeric start/end times in seconds and (when whisper
/// reports it) each segment's no_speech_prob. GPU mode comes from
/// services/gpuBackend.ts (see runWhisper).
export async function transcribe(
  audioPath: string,
  language: TranscriptionLanguage,
  trackingKey?: string,
): Promise<TranscriptSegment[]> {
  // Write whisper's output next to the audio file (always inside our own,
  // ASCII-only, repo-rooted data dir) rather than os.tmpdir() — on a machine
  // with a non-ASCII Windows account name, os.tmpdir() resolves under
  // %TEMP%\<username>\..., which would crash whisper-cli.exe just like the
  // model path issue above.
  const outputBase = path.join(path.dirname(audioPath), `.whisper-output-${randomUUID()}`);

  const parsed = await runWhisper({ audioPath, language, outputBase, trackingKey });
  const transcription = parsed.transcription ?? [];

  return transcription.map((entry) => ({
    // Verified against this whisper-cli build's actual --output-json-full
    // output: offsets.from/to are in MILLISECONDS (matching the SRT-style
    // "HH:MM:SS,mmm" timestamps strings alongside them), not centiseconds —
    // a 2.000s clip produced offsets.to === 2000. Divide by 1000 for seconds.
    start: entry.offsets.from / 1000,
    end: entry.offsets.to / 1000,
    text: (entry.text ?? '').trim(),
    // This build's JSON writer does not include a per-segment no_speech_prob
    // field even though the underlying whisper.dll API supports it, so this
    // is normally undefined — see the runWhisper() doc comment above.
    noSpeechProb: entry.no_speech_prob,
  }));
}
