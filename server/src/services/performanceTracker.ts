import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { gpuState } from './gpuBackend.js';

const STATS_FILE = path.resolve(path.dirname(config.sessionsDir), 'perf-stats.json');
const MAX_ENTRIES = 10;
// Entries recorded before AUG-125 measured a different pipeline (beam search, parallel tracks, ratio against transcript
// length) and are ignored.
const PIPELINE_VERSION = 2;
// Processing seconds per audio second, measured for AUG-125 on an M3 Pro (see project-context/transcription):
// Metal 117-127 s for the 4229 s reference session (mic + system); CPU 48 s for a 300 s dense-speech slice.
const DEFAULT_RATIO_GPU = 0.03;
const DEFAULT_RATIO_CPU = 0.16;

interface PerfEntry {
  ratio: number;
  dualTrack: boolean;
  pipeline?: number;
  gpu?: boolean;
  timestamp: string;
}

interface PerfStats {
  entries: PerfEntry[];
}

async function readStats(): Promise<PerfStats> {
  try {
    const raw = await fs.readFile(STATS_FILE, 'utf-8');
    return JSON.parse(raw) as PerfStats;
  } catch {
    return { entries: [] };
  }
}

async function writeStats(stats: PerfStats): Promise<void> {
  await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
}

/// `audioSecondsProcessed` is the audio actually fed to whisper (dual-track = mic + system seconds), so the ratio is
/// processing seconds per second of audio.
export async function recordCompletion(
  audioSecondsProcessed: number,
  processingTimeSec: number,
  dualTrack: boolean,
): Promise<void> {
  if (audioSecondsProcessed <= 0 || processingTimeSec <= 0) return;
  const ratio = processingTimeSec / audioSecondsProcessed;
  const stats = await readStats();
  stats.entries.push({ ratio, dualTrack, gpu: gpuState.useGpu(), pipeline: PIPELINE_VERSION, timestamp: new Date().toISOString() });
  if (stats.entries.length > MAX_ENTRIES) {
    stats.entries = stats.entries.slice(-MAX_ENTRIES);
  }
  await writeStats(stats);
}

export async function getEstimatedRatio(dualTrack: boolean): Promise<number> {
  const stats = await readStats();
  const useGpu = gpuState.useGpu();
  const relevant = stats.entries.filter(
    (e) => e.pipeline === PIPELINE_VERSION && e.dualTrack === dualTrack && e.gpu === useGpu,
  );
  if (relevant.length === 0) return useGpu ? DEFAULT_RATIO_GPU : DEFAULT_RATIO_CPU;
  // Median, so one outlier run (a queued job, a cold model cache) does not skew the ETA.
  const sorted = relevant.map((e) => e.ratio).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function getEstimatedDuration(
  audioDurationSec: number,
  dualTrack: boolean,
): Promise<number> {
  const ratio = await getEstimatedRatio(dualTrack);
  return Math.round(audioDurationSec * ratio);
}
