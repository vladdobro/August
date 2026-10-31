/// Live-panel text correction (AUG-164): every LIVE_CORRECTION_INTERVAL_MS, settled live chunks are sent to Groq
/// (groqText.correctSegments) and corrected text is pushed back to the client as { type: 'correction', id, text }.
/// Only the client's in-memory live panel changes — nothing is persisted; transcript.md is still built by the batch path.
/// AUG-167: yields its tick while the session's action-items call is pending (shouldYield).

import { correctSegments } from './groqText.js';

export const LIVE_CORRECTION_INTERVAL_MS = 12_000;
export const LIVE_SETTLE_MS = 8_000; // a chunk must be at least this old
export const LIVE_MAX_BATCH = 8;
export const LIVE_MAX_AGE_MS = 90_000; // older uncorrected chunks are dropped (bounded backlog after skips)

interface PendingEntry {
  id: string;
  text: string;
  emittedAt: number;
}

export class LiveTextCorrector {
  private entries: PendingEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private controller = new AbortController();

  constructor(
    private readonly onCorrection: (id: string, text: string) => void,
    private readonly correct: typeof correctSegments = correctSegments,
    private readonly now: () => number = Date.now,
    private readonly shouldYield: () => boolean = () => false,
  ) {}

  add(id: string, text: string): void {
    if (this.stopped) return;
    this.entries.push({ id, text, emittedAt: this.now() });
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), LIVE_CORRECTION_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller.abort();
    this.entries = [];
  }

  async tick(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    // AUG-167: a missed action item is lost for good, a missed correction is only unfixed text — give the shared Groq budget to action items.
    if (this.shouldYield()) {
      console.log('[correction] yielded to action-items');
      return;
    }
    const t = this.now();
    this.entries = this.entries.filter((e) => t - e.emittedAt <= LIVE_MAX_AGE_MS);
    // Never the newest chunk — it is the line currently being read.
    const batch = this.entries
      .slice(0, -1)
      .filter((e) => t - e.emittedAt >= LIVE_SETTLE_MS)
      .slice(0, LIVE_MAX_BATCH);
    if (batch.length === 0) return;

    this.inFlight = true;
    try {
      const outcome = await this.correct(batch.map(({ id, text }) => ({ id, text })), { signal: this.controller.signal });
      if (this.stopped) return;
      if (outcome.status === 'ok') {
        const ids = new Set(batch.map((e) => e.id));
        this.entries = this.entries.filter((e) => !ids.has(e.id));
        for (const [id, text] of outcome.corrections) this.onCorrection(id, text);
      }
      // skipped: leave entries; they are retried next tick until LIVE_MAX_AGE_MS drops them.
    } finally {
      this.inFlight = false;
    }
  }
}
