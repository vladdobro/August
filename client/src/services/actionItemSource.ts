// AUG-214: pure helpers for the action item source jump (live column and session card). No model calls.
import type { ActionItem } from '../types';

export const MSG_LINES_CLEARED = 'The line is no longer on screen. It will be in the transcript after the meeting.';
export const MSG_TRANSCRIPT_NOT_READY = 'The transcript is still being made. The jump will work when it is ready.';

/// A 'said' anchor without line ids only knows the chunk start; the client stamps a line when it arrives,
/// about one chunk (4 s) plus recognition later.
const SAID_ARRIVAL_SLACK_MS = 6000;

/// HH:MM:SS from the recording start.
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

interface LivePartRef { id?: string; at?: number }

/// Live: id of the transcript part an item points at, or null when it is not on screen (cleared, or never shown).
/// Items with line ids resolve only by id; items without (added by hand / by the assistant, or a said item whose
/// lines the model did not name) resolve to the last part shown at or before the anchor time.
export function resolveLivePart(item: ActionItem, lines: Array<{ parts?: LivePartRef[] }>): string | null {
  const a = item.anchor;
  if (!a) return null;
  if (a.lineIds && a.lineIds.length > 0) {
    const want = new Set(a.lineIds);
    for (const l of lines) for (const p of l.parts ?? []) if (p.id && want.has(p.id)) return p.id;
    return null;
  }
  if (typeof a.atMs !== 'number') return null;
  const limit = a.atMs + (a.kind === 'said' ? SAID_ARRIVAL_SLACK_MS : 0);
  let best: string | null = null;
  for (const l of lines) for (const p of l.parts ?? []) if (p.id && typeof p.at === 'number' && p.at <= limit) best = p.id;
  return best;
}

/// Words of 3+ letters cut to 5 chars: a crude stem that survives Russian and English endings.
function stems(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3).map((w) => w.slice(0, 5)));
}

/// Old sessions (items without a stored source): index of the line that shares the most words with the item text,
/// or -1. Needs at least 2 shared stems (1 for a one-word item) and half of the item's stems; ties keep the earliest line.
export function findBestLine(text: string, lines: string[]): number {
  const want = stems(text);
  if (want.size === 0) return -1;
  const need = Math.min(2, want.size);
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    if (!line) return;
    const have = stems(line);
    let shared = 0;
    for (const s of want) if (have.has(s)) shared++;
    if (shared < need) return;
    const score = shared / want.size;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore >= 0.5 ? best : -1;
}
