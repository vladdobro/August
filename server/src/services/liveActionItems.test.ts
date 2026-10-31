import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroqTextSkipError } from './groqText.js';
import {
  ACTION_LOCAL_MAX_CHARS,
  LiveActionItemsExtractor,
  liveLocalSlot,
  localFallbackIntervalMs,
  localFallbackTrigger,
  takeLocalChunk,
} from './liveActionItems.js';
import { LlmClientError } from './llmClient.js';

const T0 = 100_000;
const OK_CONTENT = '{"new":[{"text":"Send report","owner":"Me","source":"Me"}]}';
const WORDS = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');

function setup(opts: { localReady?: boolean; liveEngine?: 'local' | 'groq'; cloud?: () => Promise<unknown> } = {}) {
  const env = { t: T0, blocked: false };
  const store = {
    liveKey: 'k',
    version: 0,
    file: { items: [] as any[], participants: { me: '', them: '' } },
    addItems: vi.fn((raw: any[]) => {
      store.file.items.push(...raw.map((r, i) => ({ id: 'x' + store.file.items.length + i, ...r })));
      return raw.length;
    }),
    applyOps: () => 0,
  };
  const cloudChat = vi.fn(opts.cloud ?? (async () => { throw new Error('boom'); }));
  const localChat = vi.fn(async (_req: any): Promise<{ content: string }> => ({ content: OK_CONTENT }));
  const withLocal = vi.fn(async (fn: any) => fn({ chat: localChat }));
  const deps = {
    cloudChat,
    withLocal,
    localReady: async () => opts.localReady ?? true,
    now: () => env.t,
    groqBlocked: () => env.blocked,
  };
  const extractor = new LiveActionItemsExtractor(store as never, deps as never, opts.liveEngine ? { liveEngine: () => opts.liveEngine! } : undefined);
  const speak = () => extractor.addTranscript('1', 'Me', `I will send it by friday ${WORDS}`);
  speak();
  return { env, store, cloudChat, localChat, withLocal, extractor, speak };
}

let logSpy: { mock: { calls: unknown[][] }; mockRestore(): void } | null = null;
function captureLog() {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return () => logSpy!.mock.calls.map((c) => String(c[0]));
}

afterEach(() => {
  liveLocalSlot.release();
  logSpy?.mockRestore();
  logSpy = null;
});

describe('localFallbackTrigger', () => {
  it('maps Groq refusals to a trigger', () => {
    const base = { groqBlocked: false, gateOpenMs: 0 };
    expect(localFallbackTrigger({ ...base, skipReason: 'no-key' })).toBeNull();
    expect(localFallbackTrigger({ ...base, skipReason: 'rate-limited' })).toBe('rate-limited');
    expect(localFallbackTrigger({ ...base, skipReason: 'error' })).toBe('error');
    expect(localFallbackTrigger({ ...base, skipReason: 'error', groqBlocked: true })).toBe('blocked');
    expect(localFallbackTrigger({ ...base, skipReason: 'rate-budget', gateOpenMs: 30_000 })).toBeNull();
    expect(localFallbackTrigger({ ...base, skipReason: 'rate-budget', gateOpenMs: 30_001 })).toBe('rate-budget');
  });
});

describe('localFallbackIntervalMs', () => {
  it('doubles per timeout and caps', () => {
    expect(localFallbackIntervalMs('groq', 1)).toBe(60_000);
    expect(localFallbackIntervalMs('groq', 2)).toBe(120_000);
    expect(localFallbackIntervalMs('groq', 4)).toBe(240_000);
    expect(localFallbackIntervalMs('groq', 8)).toBe(240_000);
    expect(localFallbackIntervalMs('local', 1)).toBe(120_000);
    expect(localFallbackIntervalMs('local', 2)).toBe(240_000);
  });
});

describe('takeLocalChunk', () => {
  it('takes the oldest speech up to the limit', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: String(i), speaker: 'Me' as const, text: String(i).repeat(600) }));
    const { sent, transcript } = takeLocalChunk(entries, ACTION_LOCAL_MAX_CHARS);
    expect(transcript.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(ACTION_LOCAL_MAX_CHARS);
    expect(sent.map((e) => e.id)).toEqual(['0', '1', '2']);
    expect(transcript[0].text.startsWith('0')).toBe(true);
  });

  it('cuts a single long entry', () => {
    const { sent, transcript } = takeLocalChunk([{ id: 'a', speaker: 'Them', text: 'x'.repeat(3000) }], ACTION_LOCAL_MAX_CHARS);
    expect(sent).toHaveLength(1);
    expect(transcript).toHaveLength(1);
    expect(transcript[0].text).toHaveLength(2000);
  });
});

describe('local fallback (AUG-168)', () => {
  it('extracts locally after a Groq error', async () => {
    const logs = captureLog();
    const env = setup();
    let pendingInside: boolean | null = null;
    env.localChat.mockImplementation(async () => {
      pendingInside = env.extractor.cloudCallPending;
      return { content: OK_CONTENT };
    });
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(1);
    const req = env.localChat.mock.calls[0][0];
    expect(req.maxTokens).toBe(400);
    expect(req.timeoutMs).toBe(45_000);
    expect(env.store.addItems).toHaveBeenCalled();
    expect(logs().some((l) => l.includes('[actionItems] local fallback #1 (error): +1 new'))).toBe(true);
    expect(pendingInside).toBe(false);
  });

  it('keeps the old behaviour without a ready local model', async () => {
    const logs = captureLog();
    const env = setup({ localReady: false });
    await env.extractor.tick();
    expect(env.withLocal).not.toHaveBeenCalled();
    expect(logs().some((l) => l.includes('local fallback'))).toBe(false);
  });

  it('does not fall back on no-key', async () => {
    captureLog();
    const env = setup({ cloud: async () => { throw new GroqTextSkipError('no-key'); } });
    await env.extractor.tick();
    expect(env.withLocal).not.toHaveBeenCalled();
  });

  it('falls back on rate-budget only after the gate was open > 30 s', async () => {
    const logs = captureLog();
    const env = setup({ cloud: async () => { throw new GroqTextSkipError('rate-budget'); } });
    await env.extractor.tick();
    expect(env.withLocal).not.toHaveBeenCalled();
    expect(env.extractor.cloudCallPending).toBe(true);
    env.env.t += 31_000;
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(1);
    expect(logs().some((l) => l.includes('(rate-budget)'))).toBe(true);
  });

  it('reports blocked when Groq is blocked', async () => {
    const logs = captureLog();
    const env = setup({ cloud: async () => { throw new GroqTextSkipError('error'); } });
    env.env.blocked = true;
    await env.extractor.tick();
    expect(logs().some((l) => l.includes('(blocked)'))).toBe(true);
  });

  it('skips when the shared slot is busy', async () => {
    const logs = captureLog();
    const env = setup();
    expect(liveLocalSlot.tryAcquire()).toBe(true);
    await env.extractor.tick();
    expect(env.withLocal).not.toHaveBeenCalled();
    expect(logs().some((l) => l.includes('local fallback skipped: busy'))).toBe(true);
  });

  it('blocks local dedup while a local extraction runs', async () => {
    captureLog();
    const env = setup();
    let resolve!: (v: { content: string }) => void;
    env.localChat.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const p = env.extractor.tick();
    await vi.waitFor(() => expect(env.withLocal).toHaveBeenCalledTimes(1));
    env.store.file.items.push({ id: 'a', text: 'one', owner: '' }, { id: 'b', text: 'two', owner: '' });
    env.store.version = 5;
    await env.extractor.localDedupTick();
    expect(env.withLocal).toHaveBeenCalledTimes(1);
    resolve({ content: OK_CONTENT });
    await p;
    expect(liveLocalSlot.busy).toBe(false);
  });

  it('enforces the interval between local calls (groq whisper: 60 s)', async () => {
    const logs = captureLog();
    const env = setup({ liveEngine: 'groq' });
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(1);
    env.speak();
    env.env.t = T0 + 50_000;
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(1);
    expect(logs().some((l) => l.includes('local fallback skipped: interval'))).toBe(true);
    env.env.t = T0 + 100_000;
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(2);
  });

  it('uses 120 s on local whisper', async () => {
    const logs = captureLog();
    const env = setup({ liveEngine: 'local' });
    await env.extractor.tick();
    env.speak();
    env.env.t = T0 + 100_000;
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(1);
    expect(logs().some((l) => l.includes('local fallback skipped: interval'))).toBe(true);
    env.env.t = T0 + 150_000;
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(2);
  });

  it('backs off on timeouts and resets on success', async () => {
    const logs = captureLog();
    const env = setup({ liveEngine: 'groq' });
    const timeout = () => new LlmClientError('LLM request timed out or was cancelled', null);
    env.localChat.mockRejectedValueOnce(timeout());
    await env.extractor.tick();
    expect(logs().some((l) => l.includes('timeout, next local call in >= 120 s'))).toBe(true);

    env.env.t += 120_000;
    env.localChat.mockRejectedValueOnce(timeout());
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(2);
    expect(logs().some((l) => l.includes('timeout, next local call in >= 240 s'))).toBe(true);

    env.env.t += 240_000;
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(3);

    env.speak();
    env.env.t += 60_000;
    await env.extractor.tick();
    expect(env.withLocal).toHaveBeenCalledTimes(4);
    expect(logs().some((l) => l.includes('local fallback skipped: interval'))).toBe(false);
  });
});
