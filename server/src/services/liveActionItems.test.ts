import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroqTextSkipError } from './groqText.js';
import {
  ACTION_CLOUD_MAX_TOKENS,
  ACTION_LOCAL_MAX_CHARS,
  EXTRACT_SYSTEM_PROMPT,
  LOCAL_EXTRACT_SYSTEM_PROMPT,
  addAssistantItemToList,
  applyDedupOps,
  applyUserEdit,
  resolveAnchorLines,
  sanitizeActionItemsFile,
  LiveActionItemsExtractor,
  LiveActionItemsStore,
  liveLocalSlot,
  localFallbackIntervalMs,
  localFallbackTrigger,
  takeLocalChunk,
} from './liveActionItems.js';
import { LlmClientError } from './llmClient.js';
import { chunkStartMs } from './liveChunking.js';
import type { ActionItem } from '../types.js';

const T0 = 100_000;
const OK_CONTENT = '{"new":[{"text":"Send report","owner":"Me","source":"Me"}]}';
const WORDS = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');

function setup(opts: { localReady?: boolean; liveEngine?: 'local' | 'groq'; cloud?: () => Promise<unknown>; file?: Record<string, unknown> } = {}) {
  const env = { t: T0, blocked: false };
  const store = {
    liveKey: 'k',
    version: 0,
    file: { items: [] as any[], participants: { me: '', them: '' }, ...opts.file } as any,
    addItems: vi.fn((raw: any[]) => {
      store.file.items.push(...raw.map((r, i) => ({ id: 'x' + store.file.items.length + i, ...r })));
      return raw.length;
    }),
    applyOps: () => ({ applied: 0, rejected: 0 }),
  };
  const cloudChat = vi.fn((opts.cloud ?? (async () => { throw new Error('boom'); })) as (req: any) => Promise<any>);
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
  vi.useRealTimers();
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

// ---------------------------------------------------------------------------
// AUG-213: source anchor and context

const REC = 40_000; // recordingStartedAt used below; setup()'s first line starts at T0 = 100_000 -> atMs 60_000
const cloudJson = (obj: unknown) => async () => ({ content: JSON.stringify(obj) });
const payloadOf = (req: any) => JSON.parse(req.messages[1].content);
const ISO = '2026-01-01T00:00:00.000Z';
const mkItem = (over: Partial<ActionItem> = {}): ActionItem => ({ id: 'a', text: 'Send the report', owner: 'Me', source: 'Me', createdAt: ISO, ...over });

describe('sanitizeActionItemsFile (AUG-213)', () => {
  it('reads a file written before this task unchanged', () => {
    const file = sanitizeActionItemsFile({
      version: 1,
      participants: { me: 'A', them: 'B' },
      items: [{ id: 'a1', text: 'One', owner: 'Me', source: 'Me', createdAt: ISO }, { id: 'a2', text: 'Two', owner: '', source: 'Them', createdAt: ISO, locked: { text: true } }],
      updatedAt: ISO,
    });
    expect(file.version).toBe(1);
    expect(file.items).toHaveLength(2);
    expect(file.items[0].anchor).toBeUndefined();
    expect(file.items[0].context).toBeUndefined();
    expect(file.recordingStartedAt).toBeUndefined();
  });

  it('keeps valid context, anchor, locked.context and recordingStartedAt', () => {
    const anchor = { kind: 'said', atMs: 60_000, speaker: 'Them', quote: 'I will send it', lineIds: ['L1', 'L2'], line: 4 };
    const file = sanitizeActionItemsFile({
      recordingStartedAt: 1_700_000_000_000,
      items: [{ id: 'a1', text: 'One', context: 'Why it matters', anchor, locked: { context: true } }],
    });
    expect(file.recordingStartedAt).toBe(1_700_000_000_000);
    expect(file.items[0].context).toBe('Why it matters');
    expect(file.items[0].anchor).toEqual(anchor);
    expect(file.items[0].locked).toEqual({ context: true });
  });

  it('drops malformed parts and keeps the item', () => {
    const file = sanitizeActionItemsFile({
      recordingStartedAt: -5,
      items: [
        { id: 'a1', text: 'One', context: 5, anchor: { kind: 'x' } },
        { id: 'a2', text: 'Two', context: 'c'.repeat(300), anchor: { kind: 'said', quote: 'q'.repeat(500), lineIds: ['1', '2', '3', '4', '5'], line: -1, atMs: 'x' } },
      ],
    });
    expect(file.recordingStartedAt).toBeUndefined();
    expect(file.items).toHaveLength(2);
    expect(file.items[0].context).toBeUndefined();
    expect(file.items[0].anchor).toBeUndefined();
    expect(file.items[1].context).toHaveLength(240);
    expect(file.items[1].anchor?.quote).toHaveLength(400);
    expect(file.items[1].anchor?.lineIds).toEqual(['1', '2', '3']);
    expect(file.items[1].anchor?.line).toBeUndefined();
    expect(file.items[1].anchor?.atMs).toBeUndefined();
  });
});

describe('extractor anchors and context (AUG-213)', () => {
  const lineText = 'I will send the Q3 report by friday';

  it('chunkStartMs subtracts the chunk duration and the anchor atMs follows', async () => {
    captureLog();
    const T = 1_000_000;
    expect(chunkStartMs(T + 64_000, 64_000)).toBe(T + 60_000);
    const env = setup({ cloud: cloudJson({ new: [{ text: 'Send report', owner: 'Me', source: 'Me', lines: [2] }] }), file: { recordingStartedAt: T } });
    env.extractor.addTranscript('L2', 'Me', lineText, chunkStartMs(T + 64_000, 64_000));
    await env.extractor.tick();
    expect(env.store.file.items[0].anchor.atMs).toBe(60_000);
  });

  it('cloud payload numbers the lines, keeps items minimal and uses 900 tokens', async () => {
    captureLog();
    const env = setup({ cloud: cloudJson({ new: [] }) });
    env.store.file.items.push({ id: 'a', text: 'T', owner: 'Me', source: 'Me', createdAt: ISO, anchor: { kind: 'said' }, context: 'c' });
    await env.extractor.tick();
    env.speak();
    env.env.t += 60_000;
    await env.extractor.tick();
    expect(env.cloudChat).toHaveBeenCalledTimes(2);
    const first = payloadOf(env.cloudChat.mock.calls[0][0]);
    expect(first.context).toEqual([]);
    expect(first.transcript.map((e: any) => e.n)).toEqual([1]);
    const second = env.cloudChat.mock.calls[1][0];
    const p = payloadOf(second);
    expect(p.context.map((e: any) => e.n)).toEqual([1]);
    expect(p.transcript.map((e: any) => e.n)).toEqual([2]);
    expect(Object.keys(p.items[0]).sort()).toEqual(['id', 'owner', 'text']);
    expect(second.maxTokens).toBe(ACTION_CLOUD_MAX_TOKENS);
    expect(ACTION_CLOUD_MAX_TOKENS).toBe(900);
  });

  it('prompts: cloud asks for lines and one sentence, local only for lines', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"lines"');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('one sentence');
    expect(LOCAL_EXTRACT_SYSTEM_PROMPT).toContain('"lines"');
    expect(LOCAL_EXTRACT_SYSTEM_PROMPT).not.toContain('one sentence');
  });

  it('local payload entries carry n', async () => {
    captureLog();
    const env = setup();
    await env.extractor.tick();
    const p = payloadOf(env.localChat.mock.calls[0][0]);
    expect(p.transcript.map((e: any) => e.n)).toEqual([1]);
  });

  it('valid lines give a server-built quote, speaker, atMs and lineIds even if the model sends its own quote', async () => {
    captureLog();
    const env = setup({ cloud: cloudJson({ new: [{ text: 'Send report', owner: 'Me', source: 'Them', lines: [2], quote: 'MODEL QUOTE' }] }), file: { recordingStartedAt: REC } });
    env.extractor.addTranscript('L2', 'Them', `  ${lineText}  `, REC + 75_000);
    await env.extractor.tick();
    expect(env.store.file.items[0].anchor).toEqual({ kind: 'said', atMs: 75_000, speaker: 'Them', quote: lineText, lineIds: ['L2'] });
    expect(env.store.file.items[0].quote).toBeUndefined();
  });

  it('invalid or missing lines fall back to the first sent line, without a quote', async () => {
    captureLog();
    for (const lines of [[99], undefined]) {
      const env = setup({ cloud: cloudJson({ new: [{ text: 'Send report', owner: 'Me', source: 'Me', ...(lines ? { lines } : {}) }] }), file: { recordingStartedAt: REC } });
      await env.extractor.tick();
      expect(env.store.file.items[0].anchor).toEqual({ kind: 'said', atMs: 60_000 });
    }
  });

  it('Groq items get a context, local ones a quote and no context', async () => {
    captureLog();
    const out = { new: [{ text: 'Send report', owner: 'Me', source: 'Me', lines: [1], context: 'Report for the Q3 review' }] };
    const cloud = setup({ cloud: cloudJson(out), file: { recordingStartedAt: REC } });
    await cloud.extractor.tick();
    expect(cloud.store.file.items[0].context).toBe('Report for the Q3 review');

    const local = setup({ file: { recordingStartedAt: REC } });
    local.localChat.mockImplementation(async () => ({ content: JSON.stringify(out) }));
    await local.extractor.tick();
    const item = local.store.file.items[0];
    expect(item.context).toBeUndefined();
    expect(item.anchor.quote).toContain('I will send it by friday');
  });

  it('one tick is one cloud call', async () => {
    captureLog();
    const env = setup({ cloud: cloudJson({ new: [] }) });
    await env.extractor.tick();
    expect(env.cloudChat).toHaveBeenCalledTimes(1);
  });

  it('noteCorrection updates the quote of an anchored item in a real store', async () => {
    captureLog();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aug213-'));
    const store = new LiveActionItemsStore('k', { version: 1, participants: { me: '', them: '' }, items: [], updatedAt: ISO }, path.join(tmpDir, 'k.json'));
    try {
      const deps = {
        cloudChat: async () => ({ content: JSON.stringify({ new: [{ text: 'Send report', owner: 'Me', source: 'Me', lines: [1] }] }) }),
        withLocal: async () => { throw new Error('no'); },
        localReady: async () => false,
        now: () => T0,
      };
      const extractor = new LiveActionItemsExtractor(store, deps as never);
      extractor.addTranscript('L1', 'Me', `I will send the reprot by friday ${WORDS}`);
      await extractor.tick();
      expect(store.file.items[0].anchor?.lineIds).toEqual(['L1']);
      extractor.noteCorrection('L1', 'fixed text');
      expect(store.file.items[0].anchor?.quote).toBe('fixed text');
    } finally {
      await store.flush();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('applyDedupOps with anchors (AUG-213)', () => {
  const a1 = { kind: 'said' as const, atMs: 1 };
  const a2 = { kind: 'said' as const, atMs: 2 };

  it('survivor keeps its own anchor and context', () => {
    const r = applyDedupOps([mkItem({ id: 'a', anchor: a1, context: 'own' }), mkItem({ id: 'b', anchor: a2, context: 'other' })], [{ op: 'merge', into: 'a', from: 'b' }]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ anchor: a1, context: 'own' });
  });

  it('takes the removed item anchor and context when it has none', () => {
    const r = applyDedupOps([mkItem({ id: 'a' }), mkItem({ id: 'b', anchor: a2, context: 'other' })], [{ op: 'merge', into: 'a', from: 'b' }]);
    expect(r.items[0]).toMatchObject({ anchor: a2, context: 'other' });
  });

  it('does not take context when it is locked', () => {
    const r = applyDedupOps([mkItem({ id: 'a', locked: { context: true } }), mkItem({ id: 'b', context: 'other' })], [{ op: 'merge', into: 'a', from: 'b' }]);
    expect(r.items[0].context).toBeUndefined();
  });

  it('still drops delete ops and rejects dissimilar merges', () => {
    const items = [mkItem({ id: 'a' }), mkItem({ id: 'b', text: 'Completely different thing' })];
    expect(applyDedupOps(items, [{ op: 'delete', id: 'a' }]).items).toHaveLength(2);
    const r = applyDedupOps(items, [{ op: 'merge', into: 'a', from: 'b' }]);
    expect(r.items).toHaveLength(2);
    expect(r.rejected).toBe(1);
  });
});

describe('applyUserEdit with context (AUG-213)', () => {
  it('sets context and locks it', () => {
    const items = [mkItem()];
    expect(applyUserEdit(items, 'a', { context: '  Because   of Q3 ' })).toBe(true);
    expect(items[0].context).toBe('Because of Q3');
    expect(items[0].locked).toEqual({ context: true });
  });

  it('text and owner edits leave anchor and context untouched', () => {
    const anchor = { kind: 'said' as const, atMs: 5, quote: 'q' };
    const items = [mkItem({ anchor, context: 'c' })];
    applyUserEdit(items, 'a', { text: 'New text', owner: 'Them' });
    expect(items[0].anchor).toEqual(anchor);
    expect(items[0].context).toBe('c');
  });

  it('empty context removes it but keeps the lock', () => {
    const items = [mkItem({ context: 'c' })];
    expect(applyUserEdit(items, 'a', { context: '  ' })).toBe(true);
    expect(items[0].context).toBeUndefined();
    expect(items[0].locked?.context).toBe(true);
  });
});

describe('added anchors and retarget (AUG-213)', () => {
  const mkStore = (file: Record<string, unknown> = {}) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aug213s-'));
    const store = new LiveActionItemsStore('k', { version: 1, participants: { me: '', them: '' }, items: [], updatedAt: ISO, ...file }, path.join(tmpDir, 'k.json'));
    return { tmpDir, store };
  };

  it('manual and assistant items get an added anchor with atMs', async () => {
    const { tmpDir, store } = mkStore({ recordingStartedAt: 1_000_000 });
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_005_000);
      expect(store.addManualItem({ text: 'By hand' })?.anchor).toEqual({ kind: 'added', atMs: 5_000 });
      vi.setSystemTime(1_012_000);
      store.addAssistantItem({ text: 'From assistant', context: 'Said in the call' });
      expect(store.file.items[1].anchor).toEqual({ kind: 'added', atMs: 12_000 });
      expect(store.file.items[1].context).toBe('Said in the call');
    } finally {
      vi.useRealTimers();
      await store.flush();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a store that never got a transcript line (Default mode) still anchors added items', async () => {
    const { tmpDir, store } = mkStore();
    const bare = mkStore();
    try {
      store.setRecordingStartedAt(Date.now() - 10_000);
      const item = store.addManualItem({ text: 'By hand' });
      expect(item?.anchor?.kind).toBe('added');
      expect(item?.anchor?.atMs).toBeGreaterThanOrEqual(10_000);
      expect(bare.store.addManualItem({ text: 'No start' })?.anchor).toEqual({ kind: 'added' });
    } finally {
      await store.flush();
      await bare.store.flush();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(bare.tmpDir, { recursive: true, force: true });
    }
  });

  it('retarget removes lineIds', async () => {
    const { tmpDir, store } = mkStore({ items: [mkItem({ anchor: { kind: 'said', quote: 'q', lineIds: ['L1'] } })] });
    try {
      await store.retarget(path.join(tmpDir, 'session', 'action-items.json'), 'aug213-no-such-session');
      expect(store.file.items[0].anchor).toEqual({ kind: 'said', quote: 'q' });
    } finally {
      await store.flush();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('resolveAnchorLines (AUG-213)', () => {
  const md = [
    '# Transcript',
    '',
    '[00:00:10] [Me] hello there everyone',
    '[00:00:20] [Them] we should send the quarterly report soon',
    '[00:00:50] [Me] I will send the quarterly report tomorrow',
    '[00:01:30] [Them] thanks bye',
    '',
  ].join('\n');

  it('a quote match inside the window wins over a nearer line', () => {
    const items = [mkItem({ anchor: { kind: 'said', atMs: 48_000, quote: 'we should send the quarterly report soon' } })];
    expect(resolveAnchorLines(items, md)).toBe(true);
    expect(items[0].anchor?.line).toBe(1); // utterance 1 (20 s) beats the nearer utterance 2 (50 s)
  });

  it('filters by speaker when the transcript has roles', () => {
    const items = [mkItem({ anchor: { kind: 'said', atMs: 35_000, speaker: 'Me', quote: 'send the quarterly report' } })];
    resolveAnchorLines(items, md);
    expect(items[0].anchor?.line).toBe(2);
  });

  it('without a quote takes the nearest line at or before atMs', () => {
    const items = [mkItem({ anchor: { kind: 'added', atMs: 55_000 } }), mkItem({ id: 'b', anchor: { kind: 'added', atMs: 5_000 } })];
    resolveAnchorLines(items, md);
    expect(items[0].anchor?.line).toBe(2);
    expect(items[1].anchor?.line).toBeUndefined();
  });

  it('is recomputed on re-transcription and honours the shift', () => {
    const items = [mkItem({ anchor: { kind: 'added', atMs: 55_000 } })];
    expect(resolveAnchorLines(items, md)).toBe(true);
    expect(resolveAnchorLines(items, md)).toBe(false);
    const other = '[00:00:05] [Me] short\n[00:00:40] [Them] later\n';
    expect(resolveAnchorLines(items, other)).toBe(true);
    expect(items[0].anchor?.line).toBe(1);
    resolveAnchorLines(items, other, -45_000);
    expect(items[0].anchor?.line).toBe(0);
  });

  it('an item without atMs gets no line', () => {
    const items = [mkItem({ anchor: { kind: 'added', line: 3 } }), mkItem({ id: 'b' })];
    expect(resolveAnchorLines(items, md)).toBe(true);
    expect(items[0].anchor?.line).toBeUndefined();
    expect(items[1].anchor).toBeUndefined();
  });
});
