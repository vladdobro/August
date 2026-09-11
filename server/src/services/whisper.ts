import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { config, AUDIO_BOOST } from '../config.js';
import type { TranscriptionLanguage, TranscriptSegment, WhisperJsonOutput } from '../types.js';

export class WhisperError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WhisperError';
  }
}

const WAV_EXTENSIONS = new Set(['.wav']);

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

  const baseName = path.basename(audioPath, ext);
  const wavPath = path.join(path.dirname(audioPath), `${baseName}.wav`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath],
      { timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) reject(new WhisperError(`ffmpeg conversion failed: ${stderr || error.message}`, error));
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

/// whisper-cli.exe (this whisper.cpp build) crashes with
/// STATUS_STACK_BUFFER_OVERRUN when a path argument (e.g. --model) contains
/// non-ASCII characters — verified by hand: it reproduces on this machine
/// because the Windows account name is Cyrillic, so the default
/// whisper/models/... model path crashes the binary
/// outright. Converting to the legacy Windows short (8.3) path, which is
/// pure ASCII, avoids the crash. Only shells out to cmd.exe when the path
/// actually contains non-ASCII characters, so the common case (ASCII
/// Windows profile) pays no extra cost. Windows-only; a no-op path is not
/// expected on other platforms since this binary is a .exe.
export async function toSafePath(filePath: string): Promise<string> {
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
      'ffprobe',
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

export async function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (error) => {
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
      'ffmpeg',
      ['-i', safeInput, '-af', af, '-ar', String(AUDIO_BOOST.sampleRate), '-ac', '1', '-c:a', 'pcm_s16le', '-y', safeOutput],
      { timeout: 300_000 },
      (error, _stdout, stderr) => {
        if (error) reject(new WhisperError(`ffmpeg audio boost failed: ${stderr || error.message}`, error));
        else resolve();
      },
    );
  });

  return boostedPath;
}

/// Runs whisper-cli.exe against `audioPath` and returns the parsed,
/// per-segment transcript with numeric start/end times in seconds and (when
/// whisper reports it) each segment's no_speech_prob. Flags mirror
/// SplitVox's WhisperTranscriber.cs exactly: max-context 0 (anti-loop
/// defense), no-gpu (use_gpu=false), full JSON output for timestamps. Note:
/// this whisper-cli.exe build's --output-json-full does not actually emit a
/// per-segment no_speech_prob field (verified by inspecting the binary), so
/// noSpeechProb below will typically be undefined — WhisperTranscriber's
/// "layer 2" no-speech gate degrades gracefully to a no-op in that case; the
/// hallucination blacklist and dedup logic in transcriptMerger.ts are the
/// primary defenses and are unaffected.
export async function transcribe(
  audioPath: string,
  language: TranscriptionLanguage,
  trackingKey?: string,
): Promise<TranscriptSegment[]> {
  if (!(await fileExists(config.whisperBinPath))) {
    throw new WhisperError(
      `whisper-cli.exe not found at "${config.whisperBinPath}". See whisper/README.md for setup.`,
    );
  }
  if (!(await fileExists(config.whisperModelPath))) {
    throw new WhisperError(
      `Whisper model not found at "${config.whisperModelPath}". See whisper/README.md to download it.`,
    );
  }
  if (!(await fileExists(audioPath))) {
    throw new WhisperError(`Audio file not found at "${audioPath}".`);
  }

  // Write whisper's output next to the audio file (always inside our own,
  // ASCII-only, repo-rooted data dir) rather than os.tmpdir() — on a machine
  // with a non-ASCII Windows account name, os.tmpdir() resolves under
  // %TEMP%\<username>\..., which would crash whisper-cli.exe just like the
  // model path issue above.
  const outputBase = path.join(path.dirname(audioPath), `.whisper-output-${randomUUID()}`);
  const outputJsonPath = `${outputBase}.json`;

  const [safeModelPath, safeBinPath, safeAudioPath, safeOutputBase] = await Promise.all([
    toSafePath(config.whisperModelPath),
    toSafePath(config.whisperBinPath),
    toSafePath(audioPath),
    toSafePath(outputBase),
  ]);

  const args = [
    '--model', safeModelPath,
    '--language', language,
    '--max-context', '0',
    '--no-gpu',
    '--output-json-full',
    '--output-file', safeOutputBase,
    '--no-prints',
    '--threads', String(threadCount()),
    safeAudioPath,
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        safeBinPath,
        args,
        { maxBuffer: 1024 * 1024 * 64 },
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
            reject(new WhisperError(`whisper-cli.exe failed: ${stderr || error.message}`, error));
            return;
          }
          resolve();
        },
      );
      if (trackingKey) {
        const existing = activeProcesses.get(trackingKey) ?? [];
        existing.push(child);
        activeProcesses.set(trackingKey, existing);
      }
    });
  } catch (err) {
    if (err instanceof WhisperError) throw err;
    throw new WhisperError('Failed to run whisper-cli.exe', err);
  }

  let raw: string;
  try {
    raw = await fs.readFile(outputJsonPath, 'utf-8');
  } catch (err) {
    throw new WhisperError(`whisper-cli.exe did not produce output at "${outputJsonPath}"`, err);
  }

  let parsed: WhisperJsonOutput;
  try {
    parsed = JSON.parse(raw) as WhisperJsonOutput;
  } catch (err) {
    throw new WhisperError('Failed to parse whisper-cli.exe JSON output', err);
  } finally {
    // Best-effort cleanup of the temp output file; ignore failures.
    fs.unlink(outputJsonPath).catch(() => {});
  }

  const transcription = parsed.transcription ?? [];

  return transcription.map((entry) => ({
    // Verified against this whisper-cli.exe build's actual --output-json-full
    // output: offsets.from/to are in MILLISECONDS (matching the SRT-style
    // "HH:MM:SS,mmm" timestamps strings alongside them), not centiseconds —
    // a 2.000s clip produced offsets.to === 2000. Divide by 1000 for seconds.
    start: entry.offsets.from / 1000,
    end: entry.offsets.to / 1000,
    text: (entry.text ?? '').trim(),
    // This build's JSON writer does not include a per-segment no_speech_prob
    // field even though the underlying whisper.dll API supports it, so this
    // is normally undefined — see the transcribe() doc comment above.
    noSpeechProb: entry.no_speech_prob,
  }));
}
