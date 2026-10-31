/// Live action items (AUG-165): cloud model (Groq, inside the AUG-164 consent) extracts NEW items behind a cheap gate; the local model (AUG-162), when enabled and downloaded, returns merge/delete operations by id every 20 s; without it the cloud call carries the dedup in the same request. User-edited fields are locked. Items persist continuously (pending file per liveKey, moved into the session folder on upload). Transcript text and items are never logged. AUG-168: when a Groq call is refused (rate-limited, error/timeout, blocked, or rate-budget for > 30 s) and the local model is ready, the same window is extracted locally (one live local call app-wide, >= 60/120 s apart, backoff on timeout).

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import type { ActionItem, ActionItemSource, ActionItemsFile, Participants } from '../types.js';
import { GroqTextSkipError, createGroqTextClient, isGroqTextBlocked, type GroqTextSkipReason } from './groqText.js';
import { LlmClientError, type ChatCompletionRequest, type ChatCompletionResult, type LlmClient } from './llmClient.js';
import { llmInstallState, readLlmSettings } from './llmInstaller.js';
import { LlmUnavailableError, withLocalLlm } from './llmServer.js';
import * as sessionManager from './sessionManager.js';
import { syncTranscriptActionItems } from './transcriptActionItems.js';

export const ACTION_ITEMS_FILE = 'action-items.json';
export const ACTION_PENDING_DIR = path.resolve(config.sessionsDir, '..', 'live-action-items');
export const ACTION_GATE_TICK_MS = 5_000;
export const ACTION_MIN_NEW_WORDS = 25; // N: words since the last call needed for a trigger-driven call
export const ACTION_TIMEOUT_MS = 60_000; // call anyway after 60 s ...
export const ACTION_TIMEOUT_MIN_WORDS = 8; // ... if at least this much new speech arrived
export const ACTION_MIN_INTERVAL_MS = 45_000; // hard floor between cloud calls -> <= 80 calls/hour
export const ACTION_LOCAL_DEDUP_INTERVAL_MS = 20_000; // 15-30 s per spec
export const ACTION_MAX_BUFFER_CHARS = 4_000; // oldest new speech is dropped beyond this
export const ACTION_MAX_ITEMS_IN_PROMPT = 40; // newest items only
export const ACTION_CONTEXT_CHARS = 600; // tail of already-sent speech repeated as context (a call can fire mid-phrase)
export const ACTION_BUDGET_FALLBACK_MS = 30_000; // rate-budget: gate open this long without a Groq call -> local fallback
export const ACTION_LOCAL_INTERVAL_MS = 60_000; // min gap between local extractions per session
export const ACTION_LOCAL_INTERVAL_LOCAL_WHISPER_MS = 120_000; // ... when live transcription itself runs on local whisper
export const ACTION_LOCAL_MAX_INTERVAL_MS = 240_000; // timeout backoff cap
export const ACTION_LOCAL_MAX_CHARS = 2_000; // transcript chars per local request
export const ACTION_LOCAL_MAX_TOKENS = 400;
export const ACTION_LOCAL_TIMEOUT_MS = 45_000;
const MAX_TEXT = 300;
const MAX_OWNER = 60;
const MAX_NAME = 60;
const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000;

/// Phrases that suggest an agreement or a task. Lower-case substrings; checked on lower-cased text.
export const ACTION_TRIGGERS: readonly string[] = [
  'договорил', 'сделаю', 'сделаешь', 'сделает', 'сделаем', 'сделайте', 'к пятнице', 'к понедельнику', 'к вторнику', 'к среде', 'к четвергу',
  'к завтра', 'до завтра', 'до конца', 'дедлайн', 'срок', 'подготов', 'отправлю', 'отправь', 'пришлю', 'пришли', 'беру на себя', 'возьму',
  'поручаю', 'задача', 'созвонимся', 'напомни', 'проверю', 'давай ты', 'давайте',
  "i'll", 'i will', 'you will', "we'll", 'will do', 'agreed', 'deal', 'by friday', 'by monday', 'by tomorrow', 'deadline', 'action item',
  'next step', 'follow up', 'follow-up', 'send you', 'take care of', 'todo', 'to-do',
];

export function hasTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return ACTION_TRIGGERS.some((t) => lower.includes(t));
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function isValidLiveKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(key);
}

/// Pure gate; exported so it stays readable.
export function actionGateOpen(s: { newWords: number; triggerSeen: boolean; sinceLastMs: number }): boolean {
  if (s.sinceLastMs < ACTION_MIN_INTERVAL_MS || s.newWords === 0) return false;
  if (s.triggerSeen && s.newWords >= ACTION_MIN_NEW_WORDS) return true;
  return s.sinceLastMs >= ACTION_TIMEOUT_MS && s.newWords >= ACTION_TIMEOUT_MIN_WORDS;
}

export type DedupOp = { op: 'merge'; into: string; from: string } | { op: 'delete'; id: string };

export function isLocked(item: ActionItem): boolean {
  return !!(item.locked?.text || item.locked?.owner);
}

/// Applies model operations; locked items are never removed. In a merge the item with a manual edit always survives; both edited -> skipped.
export function applyDedupOps(items: ActionItem[], ops: DedupOp[]): { items: ActionItem[]; applied: number } {
  let list = items.map((i) => ({ ...i }));
  let applied = 0;
  for (const op of ops) {
    if (op.op === 'merge') {
      if (op.into === op.from) continue;
      const into = list.find((i) => i.id === op.into);
      const from = list.find((i) => i.id === op.from);
      if (!into || !from) continue;
      if (isLocked(from) && isLocked(into)) continue;
      const [survivor, removed] = isLocked(from) && !isLocked(into) ? [from, into] : [into, from];
      if (survivor.owner === '' && !survivor.locked?.owner) survivor.owner = removed.owner;
      list = list.filter((i) => i !== removed);
      applied++;
    } else {
      const item = list.find((i) => i.id === op.id);
      if (!item || isLocked(item)) continue;
      list = list.filter((i) => i !== item);
      applied++;
    }
  }
  return { items: list, applied };
}

function sanitizeOps(raw: unknown, knownIds: Set<string>): DedupOp[] {
  if (!Array.isArray(raw)) return [];
  const ops: DedupOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (o.op === 'merge') {
      if (typeof o.into === 'string' && typeof o.from === 'string' && knownIds.has(o.into) && knownIds.has(o.from)) {
        ops.push({ op: 'merge', into: o.into, from: o.from });
      }
    } else if (o.op === 'delete') {
      if (typeof o.id === 'string' && knownIds.has(o.id)) ops.push({ op: 'delete', id: o.id });
    }
  }
  return ops;
}

export function parseExtractionResponse(
  content: string,
  knownIds: Set<string>,
): { newItems: Array<{ text: string; owner: string; source: ActionItemSource }>; ops: DedupOp[] } | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const newItems: Array<{ text: string; owner: string; source: ActionItemSource }> = [];
  if (Array.isArray(o.new)) {
    for (const r of o.new) {
      if (!r || typeof r !== 'object') continue;
      const n = r as Record<string, unknown>;
      if (typeof n.text !== 'string') continue;
      const text = n.text.trim().slice(0, MAX_TEXT);
      if (!text) continue;
      const owner = typeof n.owner === 'string' ? n.owner.trim().slice(0, MAX_OWNER) : '';
      const source: ActionItemSource = n.source === 'Me' || n.source === 'Them' ? n.source : 'Them';
      newItems.push({ text, owner, source });
    }
  }
  return { newItems, ops: sanitizeOps(o.ops, knownIds) };
}

export function parseDedupResponse(content: string, knownIds: Set<string>): DedupOp[] | null {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return sanitizeOps(parsed, knownIds);
}

/// Applies a user edit; edited fields become locked. Returns false when the id is unknown or nothing valid changed.
export function applyUserEdit(items: ActionItem[], id: string, patch: { text?: unknown; owner?: unknown }): boolean {
  const item = items.find((i) => i.id === id);
  if (!item) return false;
  let changed = false;
  if (typeof patch.text === 'string') {
    const text = patch.text.trim();
    if (text) {
      item.text = text.slice(0, MAX_TEXT);
      item.locked = { ...item.locked, text: true };
      changed = true;
    }
  }
  if (typeof patch.owner === 'string') {
    item.owner = patch.owner.trim().slice(0, MAX_OWNER);
    item.locked = { ...item.locked, owner: true };
    changed = true;
  }
  return changed;
}

export function normalizeParticipants(raw: unknown): Participants {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '');
  return { me: name(o.me), them: name(o.them) };
}

function newItemId(): string {
  return `ai_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/// A hand-written item: source Me, both fields locked so model operations never merge it away or delete it. Null when the text is empty.
export function createManualItem(raw: { text?: unknown; owner?: unknown }): ActionItem | null {
  if (typeof raw.text !== 'string') return null;
  const text = raw.text.trim().slice(0, MAX_TEXT);
  if (!text) return null;
  const owner = typeof raw.owner === 'string' ? raw.owner.trim().slice(0, MAX_OWNER) : '';
  return { id: newItemId(), text, owner, source: 'Me', createdAt: new Date().toISOString(), manual: true, locked: { text: true, owner: true } };
}

function emptyFile(): ActionItemsFile {
  return { version: 1, participants: { me: '', them: '' }, items: [], updatedAt: new Date().toISOString() };
}

/// Tolerant reader: keeps valid items only.
function sanitizeFile(raw: unknown): ActionItemsFile {
  const file = emptyFile();
  if (!raw || typeof raw !== 'object') return file;
  const o = raw as Record<string, unknown>;
  file.participants = normalizeParticipants(o.participants);
  if (typeof o.updatedAt === 'string') file.updatedAt = o.updatedAt;
  if (Array.isArray(o.items)) {
    for (const r of o.items) {
      if (!r || typeof r !== 'object') continue;
      const i = r as Record<string, unknown>;
      if (typeof i.id !== 'string' || !i.id || typeof i.text !== 'string' || !i.text.trim()) continue;
      const item: ActionItem = {
        id: i.id,
        text: i.text.slice(0, MAX_TEXT),
        owner: typeof i.owner === 'string' ? i.owner.slice(0, MAX_OWNER) : '',
        source: i.source === 'Me' ? 'Me' : 'Them',
        createdAt: typeof i.createdAt === 'string' ? i.createdAt : file.updatedAt,
      };
      const lk = i.locked && typeof i.locked === 'object' ? (i.locked as Record<string, unknown>) : null;
      if (lk && (lk.text === true || lk.owner === true)) {
        item.locked = { ...(lk.text === true ? { text: true as const } : {}), ...(lk.owner === true ? { owner: true as const } : {}) };
      }
      if (i.manual === true) item.manual = true;
      const px = i.praxis && typeof i.praxis === 'object' ? (i.praxis as Record<string, unknown>) : null;
      if (px && typeof px.taskId === 'string' && typeof px.projectPath === 'string' && typeof px.sentAt === 'string') {
        item.praxis = { taskId: px.taskId, projectPath: px.projectPath, sentAt: px.sentAt };
      }
      file.items.push(item);
    }
  }
  return file;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

async function readFileIfExists(filePath: string): Promise<ActionItemsFile | null> {
  try {
    return sanitizeFile(JSON.parse(await fs.readFile(filePath, 'utf-8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.,!?;:…]+$/u, '');
}

// ---------------------------------------------------------------------------
// Store

type Listener = (file: ActionItemsFile) => void;

export class LiveActionItemsStore {
  file: ActionItemsFile;
  version = 0;
  sessionId: string | null = null;
  private targetPath: string;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<Listener>();

  constructor(readonly liveKey: string, file: ActionItemsFile, targetPath: string) {
    this.file = file;
    this.targetPath = targetPath;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.file);
    return () => { this.listeners.delete(l); };
  }

  setParticipants(p: Participants): void {
    const next = normalizeParticipants(p);
    if (next.me === this.file.participants.me && next.them === this.file.participants.them) return;
    this.file.participants = next;
    this.changed();
  }

  addItems(raw: Array<{ text: string; owner: string; source: ActionItemSource }>): number {
    let added = 0;
    for (const r of raw) {
      const key = normalizeForCompare(r.text);
      if (!key || this.file.items.some((i) => normalizeForCompare(i.text) === key)) continue;
      this.file.items.push({
        id: newItemId(),
        text: r.text,
        owner: r.owner,
        source: r.source,
        createdAt: new Date().toISOString(),
      });
      added++;
    }
    if (added > 0) this.changed();
    return added;
  }

  addManualItem(raw: { text?: unknown; owner?: unknown }): ActionItem | null {
    const item = createManualItem(raw);
    if (!item) return null;
    this.file.items.push(item);
    this.changed();
    return item;
  }

  applyOps(ops: DedupOp[]): number {
    const { items, applied } = applyDedupOps(this.file.items, ops);
    if (applied > 0) {
      this.file.items = items;
      this.changed();
    }
    return applied;
  }

  editItem(id: string, patch: { text?: unknown; owner?: unknown }): boolean {
    const ok = applyUserEdit(this.file.items, id, patch);
    if (ok) this.changed();
    return ok;
  }

  removeItem(id: string): boolean {
    const idx = this.file.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.file.items.splice(idx, 1);
    this.changed();
    return true;
  }

  /// Runs `fn` on the live items; persists and notifies when it returns true.
  mutate(fn: (items: ActionItem[]) => boolean): boolean {
    const did = fn(this.file.items);
    if (did) this.changed();
    return did;
  }

  /// Switches persistence to the session folder, writes now and removes the old pending file.
  async retarget(targetPath: string, sessionId: string): Promise<void> {
    const old = this.targetPath;
    this.targetPath = targetPath;
    this.sessionId = sessionId;
    this.changed();
    await this.flush();
    if (old !== targetPath) await fs.unlink(old).catch(() => {}); // ENOENT or locked: best effort
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private changed(): void {
    this.version++;
    this.file.updatedAt = new Date().toISOString();
    const target = this.targetPath;
    const snapshot = JSON.parse(JSON.stringify(this.file)) as ActionItemsFile;
    const sessionId = this.sessionId;
    this.writes = this.writes
      .then(() => writeJsonAtomic(target, snapshot))
      .then(() => { if (sessionId) return syncTranscriptActionItems(sessionId, snapshot); })
      .catch((err) => console.warn(`[actionItems] save failed: ${(err as Error).message}`));
    for (const l of this.listeners) l(this.file);
  }
}

// ---------------------------------------------------------------------------
// Registry

const registry = new Map<string, { store: LiveActionItemsStore; refs: number }>();

function pendingPath(liveKey: string): string {
  return path.join(ACTION_PENDING_DIR, `${liveKey}.json`);
}

async function cleanupStalePending(): Promise<void> {
  try {
    const names = await fs.readdir(ACTION_PENDING_DIR);
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(ACTION_PENDING_DIR, name);
      try {
        const st = await fs.stat(p);
        if (st.mtimeMs < cutoff) await fs.unlink(p);
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

export async function openLiveActionItems(liveKey: string): Promise<LiveActionItemsStore> {
  const existing = registry.get(liveKey);
  if (existing) {
    existing.refs++;
    return existing.store;
  }
  void cleanupStalePending();
  const file = (await readFileIfExists(pendingPath(liveKey))) ?? emptyFile();
  // Another connection may have registered the same key while we were reading.
  const raced = registry.get(liveKey);
  if (raced) {
    raced.refs++;
    return raced.store;
  }
  const store = new LiveActionItemsStore(liveKey, file, pendingPath(liveKey));
  registry.set(liveKey, { store, refs: 1 });
  return store;
}

export function releaseLiveActionItems(liveKey: string): void {
  const entry = registry.get(liveKey);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  void entry.store.flush().then(() => {
    if (registry.get(liveKey)?.refs === 0) registry.delete(liveKey);
  });
}

function sessionItemsPath(sessionId: string): string {
  return path.join(sessionManager.sessionAudioDir(sessionId), ACTION_ITEMS_FILE);
}

/// Upload of a live recording (AUG-165): move the items of `liveKey` into the new session folder. Returns the file or null when there were none.
export async function attachLiveActionItemsToSession(liveKey: string, sessionId: string): Promise<ActionItemsFile | null> {
  const target = sessionItemsPath(sessionId);
  const entry = registry.get(liveKey);
  if (entry) {
    await entry.store.retarget(target, sessionId);
    return entry.store.file;
  }
  const pending = pendingPath(liveKey);
  const file = await readFileIfExists(pending);
  if (!file) return null;
  await writeJsonAtomic(target, file);
  await fs.unlink(pending).catch(() => {});
  return file;
}

// ---------------------------------------------------------------------------
// Session-level REST helpers (after stop)

const sessionLocks = new Map<string, Promise<unknown>>();

function findStoreForSession(sessionId: string): LiveActionItemsStore | null {
  for (const { store } of registry.values()) {
    if (store.sessionId === sessionId) return store;
  }
  return null;
}

export async function readSessionActionItems(sessionId: string): Promise<ActionItemsFile | null> {
  const store = findStoreForSession(sessionId);
  if (store) return store.file;
  return readFileIfExists(sessionItemsPath(sessionId));
}

export async function mutateSessionActionItems(
  sessionId: string,
  mutate: (items: ActionItem[]) => boolean,
  opts: { createIfMissing?: boolean } = {},
): Promise<ActionItemsFile | null> {
  const store = findStoreForSession(sessionId);
  if (store) {
    store.mutate(mutate);
    return store.file;
  }
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const p = sessionItemsPath(sessionId);
    let file = await readFileIfExists(p);
    if (!file && opts.createIfMissing) {
      file = emptyFile();
      // A session recorded without live items may still carry participants in session.json.
      const session = await sessionManager.getSession(sessionId).catch(() => null);
      if (session?.participants) file.participants = normalizeParticipants(session.participants);
    }
    if (!file) return null;
    if (mutate(file.items)) {
      file.updatedAt = new Date().toISOString();
      await writeJsonAtomic(p, file);
      await syncTranscriptActionItems(sessionId, file).catch((err) => console.warn(`[actionItems] transcript section not updated: ${(err as Error).message}`));
    }
    return file;
  });
  sessionLocks.set(sessionId, run);
  try {
    return await run;
  } finally {
    if (sessionLocks.get(sessionId) === run) sessionLocks.delete(sessionId);
  }
}

/// AUG-166: items of a live recording by liveKey: the open store, else the pending file.
export async function readLiveActionItems(liveKey: string): Promise<ActionItemsFile | null> {
  const entry = registry.get(liveKey);
  if (entry) return entry.store.file;
  return readFileIfExists(pendingPath(liveKey));
}

export async function mutateLiveActionItems(liveKey: string, mutate: (items: ActionItem[]) => boolean): Promise<ActionItemsFile | null> {
  const entry = registry.get(liveKey);
  if (entry) {
    entry.store.mutate(mutate);
    return entry.store.file;
  }
  const p = pendingPath(liveKey);
  const file = await readFileIfExists(p);
  if (!file) return null;
  if (mutate(file.items)) {
    file.updatedAt = new Date().toISOString();
    await writeJsonAtomic(p, file);
  }
  return file;
}

// ---------------------------------------------------------------------------
// Extractor

export const EXTRACT_SYSTEM_PROMPT = `You track action items (agreements, tasks, promises) in a live meeting transcript.
Speakers: "Me" is the app user (microphone), "Them" is the other side. Participant names, when known, are in "participants".
Input JSON: {"participants":{"Me":string|null,"Them":string|null},"items":[{"id","text","owner"}],"context":[{"speaker","text"}],"transcript":[{"speaker","text"}],"dedup":boolean}.
"items" are already known. "transcript" is only the new speech since the last call. "context" is the speech right before it, already processed: use it only to understand what "transcript" refers to (a commitment can start in "context" and be confirmed in "transcript").
Return only NEW action items made or confirmed in "transcript" that are not already in "items". Each new item: {"text": a short task in the transcript's language with the deadline if one was said, e.g. "Подготовить отчёт к пятнице", "owner": who must do it — "Me", "Them", or a person's name said explicitly, "source": the speaker who said it, "Me" or "Them"}.
Resolve pronouns by speaker: when Me says "you will do X", the owner is Them; when Me says "I will do X", the owner is Me; the other way round when Them speaks.
Only concrete commitments or assignments; skip ideas, questions and small talk. If there is nothing new, return an empty list.
If "dedup" is true, also return operations on "items" that describe the same task: {"op":"merge","into":"<id>","from":"<id>"} keeps "into" and removes "from"; {"op":"delete","id":"<id>"} removes an item that is not a task. Never invent ids.
Reply with only JSON: {"new":[...],"ops":[...]}.`;

export const DEDUP_SYSTEM_PROMPT = `You clean up a list of meeting action items. Input: a JSON array of {"id","text","owner"}.
Find items that describe the same task (same action and object, possibly in different words) and return operations: {"op":"merge","into":"<id>","from":"<id>"} keeps "into" and removes "from"; {"op":"delete","id":"<id>"} only for an item that is clearly not a task.
Never invent ids and never rewrite text. If there is nothing to do, return [].
Reply with only a JSON array of operations.`;

/// AUG-168: small local models invent content (AUG-161), so the local prompt allows explicit commitments only and never asks for dedup.
export const LOCAL_EXTRACT_SYSTEM_PROMPT = `You find action items in a fragment of a live meeting transcript.
Speakers: "Me" is the app user, "Them" is the other side. Input JSON: {"participants":{"Me":string|null,"Them":string|null},"items":[{"id","text","owner"}],"context":[{"speaker","text"}],"transcript":[{"speaker","text"}]}.
"items" are already known; "context" is earlier speech for reference only.
Add an item only when someone in "transcript" explicitly promises to do something or explicitly assigns a task. Never invent tasks, names or deadlines that were not said. Skip ideas, questions, small talk and anything already in "items". When in doubt, add nothing.
Each item: {"text": a short task in the transcript's language with the deadline if one was said, "owner": "Me", "Them" or a name said explicitly, "source": the speaker who said it, "Me" or "Them"}. When Me says "I will", the owner is Me; when Me says "you will", the owner is Them; the other way round for Them.
Reply with only JSON: {"new":[...]}.`;

interface BufferEntry { id: string; speaker: ActionItemSource; text: string }

/// AUG-168: one live local LLM call at a time app-wide — local fallback extraction and local dedup of every session share it. Non-blocking: a busy slot skips the call. The batch semantic pass (semanticCheck, AUG-163) is deliberately not covered.
export const liveLocalSlot = {
  busy: false,
  tryAcquire(): boolean { if (this.busy) return false; this.busy = true; return true; },
  release(): void { this.busy = false; },
};

export type LocalFallbackTrigger = 'rate-limited' | 'error' | 'blocked' | 'rate-budget';

/// Which Groq refusal allows a local extraction. Timeouts arrive as 'error'. Null: no fallback.
export function localFallbackTrigger(s: { skipReason: GroqTextSkipReason; groqBlocked: boolean; gateOpenMs: number }): LocalFallbackTrigger | null {
  if (s.skipReason === 'no-key') return null;
  if (s.groqBlocked) return 'blocked';
  if (s.skipReason === 'rate-budget') return s.gateOpenMs > ACTION_BUDGET_FALLBACK_MS ? 'rate-budget' : null;
  return s.skipReason;
}

/// Min gap between local extractions: base 60 s (120 s on local whisper), doubled per consecutive timeout, capped at 240 s.
export function localFallbackIntervalMs(liveEngine: 'local' | 'groq', backoff: number): number {
  const base = liveEngine === 'local' ? ACTION_LOCAL_INTERVAL_LOCAL_WHISPER_MS : ACTION_LOCAL_INTERVAL_MS;
  return Math.min(base * backoff, ACTION_LOCAL_MAX_INTERVAL_MS);
}

/// Oldest speech first, up to maxChars (the first entry is cut when it alone is longer). `sent` are the buffer entries to drop after the call.
export function takeLocalChunk(entries: BufferEntry[], maxChars: number): { sent: BufferEntry[]; transcript: Array<{ speaker: ActionItemSource; text: string }> } {
  const sent: BufferEntry[] = [];
  const transcript: Array<{ speaker: ActionItemSource; text: string }> = [];
  let used = 0;
  for (const e of entries) {
    if (sent.length > 0 && used + e.text.length > maxChars) break;
    const text = e.text.slice(0, maxChars - used);
    sent.push(e);
    transcript.push({ speaker: e.speaker, text });
    used += text.length;
    if (used >= maxChars) break;
  }
  return { sent, transcript };
}

interface ExtractorDeps {
  cloudChat: (req: ChatCompletionRequest) => Promise<ChatCompletionResult>;
  withLocal: <T>(fn: (client: LlmClient) => Promise<T>) => Promise<T>;
  localReady: () => Promise<boolean>;
  now: () => number;
  groqBlocked?: () => boolean;
}

const defaultDeps: ExtractorDeps = {
  // New client per call so a minute 429 recovers after the limiter cooldown.
  cloudChat: (req) => createGroqTextClient().chat(req),
  withLocal: (fn) => withLocalLlm((client) => fn(client)),
  localReady: async () => {
    try {
      const s = await readLlmSettings();
      return s.enabled && (await llmInstallState(s.model)) === 'ready';
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  groqBlocked: isGroqTextBlocked,
};

export class LiveActionItemsExtractor {
  private buffer: BufferEntry[] = [];
  private context: BufferEntry[] = [];
  private lastCallAt = 0;
  private inFlight = false;
  private priorityPending = false;
  private localInFlight = false;
  private stopped = false;
  private localReady = false;
  private lastDedupVersion = -1;
  private cloudCalls = 0;
  private gateOpenedAt = 0;
  private lastLocalAt = 0;
  private localBackoff = 1;
  private localCalls = 0;
  private controller = new AbortController();
  private gateTimer: NodeJS.Timeout | null = null;
  private dedupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly store: LiveActionItemsStore, private readonly deps: ExtractorDeps = defaultDeps, private readonly opts: { liveEngine?: () => 'local' | 'groq' } = {}) {}

  /// AUG-167: true from the moment the gate opens until the cloud call goes through; LiveTextCorrector yields while it is set. A rate-budget skip keeps it set (the gate stays open and retries on the next 5 s tick). AUG-168: cleared as soon as the extractor switches to a local call — the priority covers Groq calls only.
  get cloudCallPending(): boolean { return this.priorityPending; }

  start(): void {
    this.lastCallAt = this.deps.now();
    this.gateTimer = setInterval(() => { void this.tick(); }, ACTION_GATE_TICK_MS);
    this.gateTimer.unref?.();
    this.dedupTimer = setInterval(() => { void this.localDedupTick(); }, ACTION_LOCAL_DEDUP_INTERVAL_MS);
    this.dedupTimer.unref?.();
    void this.refreshLocalReady();
  }

  stop(): void {
    this.stopped = true;
    this.priorityPending = false;
    if (this.gateTimer) clearInterval(this.gateTimer);
    if (this.dedupTimer) clearInterval(this.dedupTimer);
    this.gateTimer = null;
    this.dedupTimer = null;
    this.controller.abort();
    this.buffer = [];
    this.context = [];
  }

  addTranscript(id: string, speaker: ActionItemSource, text: string): void {
    this.buffer.push({ id, speaker, text });
    let total = this.buffer.reduce((n, e) => n + e.text.length, 0);
    while (total > ACTION_MAX_BUFFER_CHARS && this.buffer.length > 1) {
      total -= this.buffer.shift()!.text.length;
    }
  }

  /// AUG-164 corrected chunk still in the buffer: replace its text.
  noteCorrection(id: string, text: string): void {
    const entry = this.buffer.find((e) => e.id === id);
    if (entry) entry.text = text;
  }

  private async refreshLocalReady(): Promise<void> {
    try {
      this.localReady = await this.deps.localReady();
    } catch {
      this.localReady = false;
    }
  }

  /// Sent speech leaves the buffer but its tail stays as context for the next call: a call can fire mid-phrase.
  private dropSent(snapshot: BufferEntry[]): void {
    const sent = new Set(snapshot);
    this.buffer = this.buffer.filter((e) => !sent.has(e));
    this.context = [...this.context, ...snapshot];
    let total = this.context.reduce((n, e) => n + e.text.length, 0);
    while (total > ACTION_CONTEXT_CHARS && this.context.length > 1) total -= this.context.shift()!.text.length;
  }

  async tick(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    const newWords = this.buffer.reduce((n, e) => n + countWords(e.text), 0);
    const triggerSeen = this.buffer.some((e) => hasTrigger(e.text));
    const sinceLastMs = this.deps.now() - this.lastCallAt;
    if (!actionGateOpen({ newWords, triggerSeen, sinceLastMs })) { this.priorityPending = false; this.gateOpenedAt = 0; return; }
    if (this.gateOpenedAt === 0) this.gateOpenedAt = this.deps.now();
    this.priorityPending = true;

    this.inFlight = true;
    const snapshot = this.buffer.slice();
    const reason = triggerSeen && newWords >= ACTION_MIN_NEW_WORDS ? 'trigger' : 'timeout';
    let keepPending = false;
    try {
      const dedup = !this.localReady && this.store.file.items.length >= 2;
      const sentItems = this.store.file.items.slice(-ACTION_MAX_ITEMS_IN_PROMPT).map(({ id, text, owner }) => ({ id, text, owner }));
      const p = this.store.file.participants;
      const payload = {
        participants: { Me: p.me || null, Them: p.them || null },
        items: sentItems,
        context: this.context.map(({ speaker, text }) => ({ speaker, text })),
        transcript: snapshot.map(({ speaker, text }) => ({ speaker, text })),
        dedup,
      };
      const result = await this.deps.cloudChat({
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        temperature: 0,
        maxTokens: 600,
        timeoutMs: 20_000,
        signal: this.controller.signal,
      });
      if (this.stopped) return;
      this.cloudCalls++;
      this.lastCallAt = this.deps.now();
      this.gateOpenedAt = 0;
      this.dropSent(snapshot);
      const parsed = parseExtractionResponse(result.content, new Set(sentItems.map((i) => i.id)));
      if (!parsed) {
        console.log(`[actionItems] cloud call #${this.cloudCalls} (${reason}): unparseable`);
      } else {
        const added = this.store.addItems(parsed.newItems);
        const applied = dedup ? this.store.applyOps(parsed.ops) : 0;
        console.log(`[actionItems] cloud call #${this.cloudCalls} (${reason}, dedup=${dedup ? 'cloud' : this.localReady ? 'local' : 'none'}): +${added} new, ${applied} op(s), ${this.store.file.items.length} total`);
      }
    } catch (err) {
      if (this.stopped) return;
      const skipReason: GroqTextSkipReason = err instanceof GroqTextSkipError ? err.reason : 'error';
      const trigger = localFallbackTrigger({ skipReason, groqBlocked: this.deps.groqBlocked?.() ?? false, gateOpenMs: this.deps.now() - this.gateOpenedAt });
      if (skipReason === 'rate-budget' && !trigger) {
        keepPending = true;
        console.log('[actionItems] cloud call skipped: rate-budget');
      } else {
        if (skipReason === 'rate-limited' || skipReason === 'error') this.cloudCalls++;
        this.lastCallAt = this.deps.now();
        this.gateOpenedAt = 0;
        console.log(`[actionItems] cloud call skipped: ${skipReason}`);
        if (trigger) await this.runLocalFallback(trigger, snapshot);
        else this.dropSent(snapshot);
      }
    } finally {
      this.inFlight = false;
      if (!keepPending) this.priorityPending = false;
    }
  }

  private localIntervalMs(): number {
    return localFallbackIntervalMs(this.opts.liveEngine?.() ?? 'local', this.localBackoff);
  }

  /// AUG-168: extraction of a refused window through the local model. Without a ready local model the window is dropped exactly as before; when the interval or the shared slot blocks the call, the speech stays in the buffer for the next attempt.
  private async runLocalFallback(trigger: LocalFallbackTrigger, snapshot: BufferEntry[]): Promise<void> {
    this.priorityPending = false; // AUG-167 priority covers Groq calls only
    const skip = (reason: string) => console.log(`[actionItems] local fallback skipped: ${reason}`);
    await this.refreshLocalReady();
    if (this.stopped) return;
    if (!this.localReady) { this.dropSent(snapshot); return; }
    const now = this.deps.now();
    if (this.lastLocalAt > 0 && now - this.lastLocalAt < this.localIntervalMs()) { skip('interval'); return; }
    if (!liveLocalSlot.tryAcquire()) { skip('busy'); return; }
    this.lastLocalAt = now;
    const n = ++this.localCalls;
    try {
      const { sent, transcript } = takeLocalChunk(snapshot, ACTION_LOCAL_MAX_CHARS);
      const sentItems = this.store.file.items.slice(-ACTION_MAX_ITEMS_IN_PROMPT).map(({ id, text, owner }) => ({ id, text, owner }));
      const p = this.store.file.participants;
      const payload = {
        participants: { Me: p.me || null, Them: p.them || null },
        items: sentItems,
        context: this.context.map(({ speaker, text }) => ({ speaker, text })),
        transcript,
      };
      const content = (
        await this.deps.withLocal((client) =>
          client.chat({
            messages: [
              { role: 'system', content: LOCAL_EXTRACT_SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(payload) },
            ],
            temperature: 0,
            maxTokens: ACTION_LOCAL_MAX_TOKENS,
            timeoutMs: ACTION_LOCAL_TIMEOUT_MS,
            signal: this.controller.signal,
          }),
        )
      ).content;
      if (this.stopped) return;
      this.localBackoff = 1;
      this.dropSent(sent);
      const parsed = parseExtractionResponse(content, new Set(sentItems.map((i) => i.id)));
      if (!parsed) console.log(`[actionItems] local fallback #${n} (${trigger}): unparseable`);
      else {
        const added = this.store.addItems(parsed.newItems);
        console.log(`[actionItems] local fallback #${n} (${trigger}): +${added} new, ${this.store.file.items.length} total`);
      }
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof LlmUnavailableError) { this.localReady = false; skip('local model unavailable'); }
      else if (err instanceof LlmClientError && err.status === null && err.message.includes('timed out')) {
        this.localBackoff = Math.min(this.localBackoff * 2, 4);
        skip(`timeout, next local call in >= ${Math.round(this.localIntervalMs() / 1000)} s`);
      } else skip('error');
    } finally {
      liveLocalSlot.release();
    }
  }

  async localDedupTick(): Promise<void> {
    if (this.stopped || this.localInFlight) return;
    await this.refreshLocalReady();
    if (!this.localReady) return;
    const items = this.store.file.items;
    if (items.length < 2 || this.store.version === this.lastDedupVersion) return;
    if (!liveLocalSlot.tryAcquire()) return; // AUG-168: a local extraction (any session) is running

    this.localInFlight = true;
    try {
      const list = items.map(({ id, text, owner }) => ({ id, text, owner }));
      const known = new Set(list.map((i) => i.id));
      const content = (
        await this.deps.withLocal((client) =>
          client.chat({
            messages: [
              { role: 'system', content: DEDUP_SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(list) },
            ],
            temperature: 0,
            maxTokens: 256,
            timeoutMs: 30_000,
            signal: this.controller.signal,
          }),
        )
      ).content;
      if (this.stopped) return;
      const ops = parseDedupResponse(content, known) ?? [];
      const applied = this.store.applyOps(ops);
      this.lastDedupVersion = this.store.version;
      if (applied > 0 || ops.length > 0) console.log(`[actionItems] local dedup: ${applied}/${ops.length} op(s) applied`);
    } catch (err) {
      if (err instanceof LlmUnavailableError) this.localReady = false;
      console.log(`[actionItems] local dedup skipped: ${(err as Error).message}`);
    } finally {
      this.localInFlight = false;
      liveLocalSlot.release();
    }
  }
}
