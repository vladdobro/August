import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroqTextSkipError } from './groqText.js';
import {
  ACTION_LOCAL_MAX_CHARS,
  addAssistantItemToList,
  sanitizeActionItemsFile,
  LiveActionItemsExtractor,
  LiveActionItemsStore,
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
    applyOps: () => ({ applied: 0, rejected: 0 }),
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

describe('addAssistantItemToList (AUG-199)', () => {
  const NOW = new Date('2026-11-06T10:00:00.000Z');

  it('creates a manual, locked item from Me with the assistant field', () => {
    const items: import('../types.js').ActionItem[] = [];
    const r = addAssistantItemToList(items, { text: ' Check the mac build by Friday ', owner: 'Them', projectPath: 'D:\proj' }, NOW);
    expect(r.changed).toBe(true);
    expect(r.result?.status).toBe('created');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: r.result?.id,
      text: 'Check the mac build by Friday',
      owner: 'Them',
      source: 'Me',
      manual: true,
      locked: { text: true, owner: true },
      assistant: { projectPath: 'D:\proj', at: NOW.toISOString() },
    });
    expect(items[0].praxis).toBeUndefined();
  });

  it('owner defaults to Me for anything else', () => {
    const items: import('../types.js').ActionItem[] = [];
    addAssistantItemToList(items, { text: 'Do it', owner: 'Anna' }, NOW);
    expect(items[0].owner).toBe('Me');
  });

  it('detects a duplicate by exact text', () => {
    const items: import('../types.js').ActionItem[] = [];
    const first = addAssistantItemToList(items, { text: 'Send the report.' }, NOW);
    const second = addAssistantItemToList(items, { text: 'send the report' }, NOW);
    expect(second.result).toEqual({ status: 'duplicate', id: first.result!.id });
    expect(second.changed).toBe(false);
    expect(items).toHaveLength(1);
  });

  it('detects a duplicate by similar wording', () => {
    const items: import('../types.js').ActionItem[] = [];
    const first = addAssistantItemToList(items, { text: 'Update the assistant panel mockup to 420 px' }, NOW);
    const second = addAssistantItemToList(items, { text: 'Update assistant panel mockup to 420 px width' }, NOW);
    expect(second.result?.status).toBe('duplicate');
    expect(second.result?.id).toBe(first.result!.id);
    expect(items).toHaveLength(1);
  });

  it('praxisTaskId marks a duplicate item and a created one', () => {
    const items: import('../types.js').ActionItem[] = [];
    const made = addAssistantItemToList(items, { text: 'Write the release notes', praxisTaskId: 'AUG-5-abc123', projectPath: 'P' }, NOW);
    expect(items[0].praxis).toEqual({ taskId: 'AUG-5-abc123', projectPath: 'P', sentAt: NOW.toISOString() });
    expect(made.result?.status).toBe('created');

    const other: import('../types.js').ActionItem[] = [];
    addAssistantItemToList(other, { text: 'Write the release notes' }, NOW);
    const dup = addAssistantItemToList(other, { text: 'Write the release notes', praxisTaskId: 'AUG-6-zzzzzz', projectPath: 'Q' }, NOW);
    expect(dup.result?.status).toBe('duplicate');
    expect(dup.changed).toBe(true);
    expect(other[0].praxis).toEqual({ taskId: 'AUG-6-zzzzzz', projectPath: 'Q', sentAt: NOW.toISOString() });
  });

  it('rejects invalid text', () => {
    const items: import('../types.js').ActionItem[] = [];
    expect(addAssistantItemToList(items, { text: '   ' })).toEqual({ result: null, changed: false });
    expect(addAssistantItemToList(items, { text: 'x'.repeat(301) })).toEqual({ result: null, changed: false });
    expect(addAssistantItemToList(items, { text: 42 })).toEqual({ result: null, changed: false });
    expect(items).toHaveLength(0);
  });

  it('assistant survives the tolerant reader', () => {
    const file = sanitizeActionItemsFile({
      items: [
        { id: 'a1', text: 'One', owner: 'Me', source: 'Me', createdAt: 'x', assistant: { projectPath: 'P', at: '2026-11-06T10:00:00.000Z' } },
        { id: 'a2', text: 'Two', assistant: { projectPath: 5 } },
      ],
    });
    expect(file.items[0].assistant).toEqual({ projectPath: 'P', at: '2026-11-06T10:00:00.000Z' });
    expect(file.items[1].assistant).toBeUndefined();
  });
});

describe('meeting-only store (AUG-200)', () => {
  it('holds manual and assistant items, notifies and persists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aug200-'));
    const target = path.join(tmpDir, 'k.json');
    const store = new LiveActionItemsStore('k', { version: 1, participants: { me: '', them: '' }, items: [], updatedAt: new Date().toISOString() }, target);
    try {
      const seen: number[] = [];
      store.subscribe((f) => seen.push(f.items.length));
      const manual = store.addManualItem({ text: 'Book the room', owner: 'Them' });
      expect(manual?.manual).toBe(true);
      expect(manual?.locked).toEqual({ text: true, owner: true });
      const r = store.addAssistantItem({ text: 'Send the deck', projectPath: 'C:/p' });
      expect(r?.status).toBe('created');
      expect(store.file.items).toHaveLength(2);
      expect(store.file.items[1].assistant).toBeDefined();
      expect(seen[seen.length - 1]).toBe(2);
      await store.flush();
      const onDisk = JSON.parse(fs.readFileSync(target, 'utf-8'));
      expect(onDisk.items).toHaveLength(2);
    } finally {
      await store.flush();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
