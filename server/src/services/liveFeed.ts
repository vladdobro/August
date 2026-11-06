/// AUG-199 (contract of AUG-196 §5): in-memory ring of the live transcript per liveKey, shared by the meeting assistant and the copilot. Never persisted, never logged.

export type FeedSpeaker = 'Me' | 'Them';

export interface FeedLine {
  id: string;
  speaker: FeedSpeaker;
  text: string;
  at: number;
  corrected?: true;
}

export type FeedListener = (line: FeedLine, kind: 'push' | 'correct') => void;

export const FEED_MAX_AGE_MS = 20 * 60_000;
export const FEED_MAX_WORDS = 6_000;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export class LiveFeed {
  readonly startedAt: number;
  private lines: FeedLine[] = [];
  private totalWords = 0;
  private listeners = new Set<FeedListener>();

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  push(line: { id: string; speaker: FeedSpeaker; text: string }): void {
    const entry: FeedLine = { id: line.id, speaker: line.speaker, text: line.text, at: this.now() };
    this.lines.push(entry);
    this.totalWords += words(entry.text);
    this.evict();
    for (const l of this.listeners) l(entry, 'push');
  }

  correct(id: string, text: string): void {
    const entry = this.lines.find((l) => l.id === id);
    if (!entry) return;
    this.totalWords += words(text) - words(entry.text);
    entry.text = text;
    entry.corrected = true;
    for (const l of this.listeners) l(entry, 'correct');
  }

  subscribe(fn: FeedListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(windowMs: number): FeedLine[] {
    const from = this.now() - windowMs;
    return this.lines.filter((l) => l.at >= from).map((l) => ({ ...l }));
  }

  /// The line `id`, `before` lines before it and the lines spoken within `afterMs` after it, cut at `maxWords` words.
  around(id: string, o: { before?: number; afterMs?: number; maxWords?: number } = {}): FeedLine[] {
    const before = o.before ?? 1;
    const afterMs = o.afterMs ?? 8_000;
    const maxWords = o.maxWords ?? 80;
    const idx = this.lines.findIndex((l) => l.id === id);
    if (idx < 0) return [];
    const anchor = this.lines[idx];
    const out: FeedLine[] = [];
    let used = 0;
    for (let i = Math.max(0, idx - before); i < this.lines.length; i++) {
      const l = this.lines[i];
      if (i > idx && l.at - anchor.at > afterMs) break;
      const w = words(l.text);
      if (out.length > 0 && used + w > maxWords) break;
      out.push({ ...l });
      used += w;
    }
    return out;
  }

  formatLine(line: FeedLine): string {
    const s = Math.max(0, Math.floor((line.at - this.startedAt) / 1000));
    const p = (n: number) => String(n).padStart(2, '0');
    return `[${line.speaker}] ${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)} ${line.text}`;
  }

  private evict(): void {
    const cutoff = this.now() - FEED_MAX_AGE_MS;
    while (this.lines.length > 0 && (this.lines[0].at < cutoff || this.totalWords > FEED_MAX_WORDS)) {
      this.totalWords -= words(this.lines[0].text);
      this.lines.shift();
    }
  }
}

const registry = new Map<string, { feed: LiveFeed; refs: number }>();

export function acquireLiveFeed(liveKey: string): LiveFeed {
  const e = registry.get(liveKey);
  if (e) {
    e.refs++;
    return e.feed;
  }
  const feed = new LiveFeed();
  registry.set(liveKey, { feed, refs: 1 });
  return feed;
}

export function releaseLiveFeed(liveKey: string): void {
  const e = registry.get(liveKey);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) registry.delete(liveKey);
}

export function getLiveFeed(liveKey: string): LiveFeed | null {
  return registry.get(liveKey)?.feed ?? null;
}
