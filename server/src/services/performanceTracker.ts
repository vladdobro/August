import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const STATS_FILE = path.resolve(path.dirname(config.sessionsDir), 'perf-stats.json');
const MAX_ENTRIES = 10;
const DEFAULT_RATIO_SINGLE = 1.5;
const DEFAULT_RATIO_DUAL = 2.85;

interface PerfEntry {
  ratio: number;
  dualTrack: boolean;
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

export async function recordCompletion(
  audioDurationSec: number,
  processingTimeSec: number,
  dualTrack: boolean,
): Promise<void> {
  if (audioDurationSec <= 0 || processingTimeSec <= 0) return;
  const ratio = processingTimeSec / audioDurationSec;
  const stats = await readStats();
  stats.entries.push({ ratio, dualTrack, timestamp: new Date().toISOString() });
  if (stats.entries.length > MAX_ENTRIES) {
    stats.entries = stats.entries.slice(-MAX_ENTRIES);
  }
  await writeStats(stats);
}

export async function getEstimatedRatio(dualTrack: boolean): Promise<number> {
  const stats = await readStats();
  const relevant = stats.entries.filter(e => e.dualTrack === dualTrack);
  if (relevant.length === 0) return dualTrack ? DEFAULT_RATIO_DUAL : DEFAULT_RATIO_SINGLE;
  const sum = relevant.reduce((acc, e) => acc + e.ratio, 0);
  return sum / relevant.length;
}

export async function getEstimatedDuration(
  audioDurationSec: number,
  dualTrack: boolean,
): Promise<number> {
  const ratio = await getEstimatedRatio(dualTrack);
  return Math.round(audioDurationSec * ratio);
}
