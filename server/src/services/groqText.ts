/// Online text correction through Groq's OpenAI-compatible chat API (AUG-164). Opt-in only: the user must accept a
/// consent in Settings (stored in preferences together with a fingerprint of the Groq key it was given for).
/// Free tier only — never upgrade, never retry on a paid path.

import { createHash } from 'node:crypto';

import { config } from '../config.js';
import { createLlmClient, LlmClientError, type ChatCompletionRequest, type LlmClient } from './llmClient.js';
import { readPreferences, type PreferencesRecord } from './preferencesStore.js';

export const GROQ_TEXT_BASE_URL = 'https://api.groq.com/openai/v1';
/// llama-3.1-8b-instant (the original choice) was removed from Groq by 2026-10; gpt-oss-20b gave the best fixes in a
/// side-by-side check. It is a reasoning model: low effort keeps the hidden reasoning (counted in max_tokens and TPM) small.
export const GROQ_TEXT_MODEL = 'openai/gpt-oss-20b';
const GROQ_TEXT_REASONING_EFFORT = 'low';
/// Hidden reasoning tokens come out of max_tokens; without this headroom short answers get cut off.
const REASONING_HEADROOM_TOKENS = 512;
/// Conservative free-tier budget, verify for the model at console.groq.com/settings/limits. Separate from
/// whisper-large-v3's 20 RPM in groqTranscription.ts. Free tier only — never upgrade, never retry on a paid path.
export const GROQ_TEXT_RPM = 30;
export const GROQ_TEXT_TPM = 6_000;

const WINDOW_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface RateEntry {
  t: number;
  tokens: number;
}

/// Sliding 60 s window over both requests and tokens.
export class TextRateLimiter {
  private entries: RateEntry[] = [];
  private cooldownUntil = 0;

  canProceed(estimatedTokens: number): boolean {
    const now = Date.now();
    this.entries = this.entries.filter((e) => now - e.t <= WINDOW_MS);
    if (now < this.cooldownUntil) return false;
    if (this.entries.length >= GROQ_TEXT_RPM) return false;
    const used = this.entries.reduce((sum, e) => sum + e.tokens, 0);
    return used + estimatedTokens <= GROQ_TEXT_TPM;
  }

  /// Returns the entry so the caller can overwrite `.tokens` with the real usage.
  record(tokens: number): RateEntry {
    const entry: RateEntry = { t: Date.now(), tokens };
    this.entries.push(entry);
    return entry;
  }

  cooldown(ms: number): void {
    this.cooldownUntil = Date.now() + ms;
  }
}

const limiter = new TextRateLimiter();

/// Conservative token estimate (Cyrillic costs more tokens per character than Latin).
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface GroqTextConsent {
  acceptedAt: string;
  keyFingerprint: string;
}

export function groqKeyFingerprint(key: string | null | undefined): string | null {
  if (!key) return null;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export interface GroqTextState {
  enabled: boolean;
  consentAt: string | null;
  consentStale: boolean;
  groqAvailable: boolean;
  model: string;
  /// Groq refused the last BLOCKED_AFTER requests in a row with 403 (region / network block). In-memory only.
  blocked: boolean;
}

/// One 403 can be a flaky VPN exit; several in a row with no success in between mean Groq is not reachable from here.
const BLOCKED_AFTER = 3;
let consecutiveForbidden = 0;

function noteRequestOutcome(status: 'ok' | number | null): void {
  if (status === 'ok') consecutiveForbidden = 0;
  else if (status === 403) consecutiveForbidden += 1;
}

export function groqTextState(prefs: PreferencesRecord, apiKey: string | null = config.groqApiKey): GroqTextState {
  const raw = prefs.groqTextConsent as Partial<GroqTextConsent> | null | undefined;
  const consent: GroqTextConsent | null =
    raw && typeof raw === 'object' && typeof raw.acceptedAt === 'string' && typeof raw.keyFingerprint === 'string'
      ? { acceptedAt: raw.acceptedAt, keyFingerprint: raw.keyFingerprint }
      : null;
  const valid = !!apiKey && !!consent && consent.keyFingerprint === groqKeyFingerprint(apiKey);
  const requested = prefs.groqTextEnabled === true;
  return {
    enabled: requested && valid,
    // Key changed or removed after consent: the consent must be shown again.
    consentStale: requested && !valid,
    consentAt: valid && consent ? consent.acceptedAt : null,
    groqAvailable: !!apiKey,
    model: GROQ_TEXT_MODEL,
    blocked: consecutiveForbidden >= BLOCKED_AFTER,
  };
}

export async function isGroqTextActive(): Promise<boolean> {
  return groqTextState(await readPreferences()).enabled;
}

export interface TextSegment {
  id: string;
  text: string;
}

export type CorrectionOutcome =
  | { status: 'ok'; corrections: Map<string, string> }
  | { status: 'skipped'; reason: 'no-key' | 'rate-budget' | 'rate-limited' | 'error' | 'unparseable' };

export const CORRECTION_SYSTEM_PROMPT =
  'You fix speech-recognition errors in fragments of a meeting transcript. Rules: fix only misrecognized words, spelling and obvious punctuation; never add, remove, reorder, summarize or translate content; keep each fragment in its original language; never answer or comment on the content; if you are not sure, return the fragment exactly as it was. Input is a JSON array of objects {"id","text"}. Reply with only a JSON array of {"id","text"} with the same ids in the same order, nothing else.';

/// Rejects empty, unchanged or suspiciously different rewrites (the model is only allowed to fix, not rewrite).
export function acceptCorrection(original: string, corrected: string): boolean {
  const o = original.trim();
  const c = corrected.trim();
  if (c.length === 0 || c === o) return false;
  const a = o.split(/\s+/).length;
  const b = c.split(/\s+/).length;
  if (Math.abs(a - b) > Math.max(2, Math.ceil(a * 0.25))) return false;
  const ratio = o.length > 0 ? c.length / o.length : Infinity;
  return ratio >= 0.6 && ratio <= 1.6;
}

export function parseCorrectionResponse(content: string, segments: TextSegment[]): Map<string, string> | null {
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
  const originals = new Map(segments.map((s) => [s.id, s.text]));
  const result = new Map<string, string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { id, text } = item as { id?: unknown; text?: unknown };
    if (typeof id !== 'string' || typeof text !== 'string') continue;
    const original = originals.get(id);
    if (original === undefined) continue;
    const trimmed = text.trim();
    if (acceptCorrection(original, trimmed)) result.set(id, trimmed);
  }
  return result;
}

function logSkipped(reason: string, count: number, detail?: string): void {
  console.log(`[groqText] skipped: ${reason} (${count} segment(s))${detail ? ` — ${detail}` : ''}`);
}

export type GroqTextSkipReason = 'no-key' | 'rate-budget' | 'rate-limited' | 'error';

export class GroqTextSkipError extends Error {
  reason: GroqTextSkipReason;
  constructor(reason: GroqTextSkipReason) {
    super(`Groq text request skipped: ${reason}`);
    this.name = 'GroqTextSkipError';
    this.reason = reason;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// AUG-164: an LlmClient for Groq text that always goes through the free-tier limiter. Over budget, a 429 or any
/// failure is logged as skipped and thrown as GroqTextSkipError — callers drop that request, never surface it.
/// waitForBudgetMs > 0 (batch) waits for the 60 s window to free up instead of skipping at once; after a 429 every
/// later call on the same client is skipped immediately (daily or minute limit exhausted — never a paid tier).
export function createGroqTextClient(opts: { waitForBudgetMs?: number } = {}): LlmClient {
  let exhausted = false;
  return {
    async chat(req: ChatCompletionRequest) {
      const apiKey = config.groqApiKey;
      if (!apiKey) { logSkipped('no-key', 1); throw new GroqTextSkipError('no-key'); }
      if (exhausted) { logSkipped('rate-limited', 1); throw new GroqTextSkipError('rate-limited'); }
      const maxTokens = (req.maxTokens ?? 256) + REASONING_HEADROOM_TOKENS;
      const estimate = estimateTokens(req.messages.map((m) => m.content).join('\n')) + maxTokens;
      const waitUntil = Date.now() + (opts.waitForBudgetMs ?? 0);
      while (!limiter.canProceed(estimate)) {
        if (Date.now() >= waitUntil || req.signal?.aborted) { logSkipped('rate-budget', 1); throw new GroqTextSkipError('rate-budget'); }
        await sleep(2_000);
      }
      const entry = limiter.record(estimate);
      // Created per call: the key can change at runtime via POST /api/config/groq-key.
      const client = createLlmClient({ baseURL: GROQ_TEXT_BASE_URL, apiKey, defaultModel: GROQ_TEXT_MODEL });
      try {
        const result = await client.chat({
          ...req,
          model: GROQ_TEXT_MODEL,
          maxTokens,
          reasoningEffort: GROQ_TEXT_REASONING_EFFORT,
          logprobs: false,
          timeoutMs: req.timeoutMs ?? REQUEST_TIMEOUT_MS,
        });
        noteRequestOutcome('ok');
        if (result.usage) entry.tokens = result.usage.promptTokens + result.usage.completionTokens;
        return result;
      } catch (err) {
        if (err instanceof LlmClientError && err.status === 429) {
          limiter.cooldown(RATE_LIMIT_COOLDOWN_MS);
          exhausted = true;
          logSkipped('rate-limited', 1);
          throw new GroqTextSkipError('rate-limited');
        }
        noteRequestOutcome(err instanceof LlmClientError ? err.status : null);
        // A refused or failed request used no tokens; keep it in the RPM count only, or retries drain the TPM budget.
        entry.tokens = 0;
        // The error body is Groq's short reason (e.g. "Forbidden" vs "Access denied. Please check your network settings");
        // it never contains transcript text.
        logSkipped('error', 1, err instanceof LlmClientError ? `HTTP ${err.status ?? 'n/a'} ${err.message.replace(/^.*?HTTP \d+\s*/, '').slice(0, 120)}` : undefined);
        throw new GroqTextSkipError('error');
      }
    },
    // Raw completions (perplexity scoring) are local-only; Groq text is used through chat.
    async complete() {
      throw new GroqTextSkipError('error');
    },
  };
}

/// Never throws. Transcript text and the API key are never logged.
export async function correctSegments(segments: TextSegment[], opts: { signal?: AbortSignal } = {}): Promise<CorrectionOutcome> {
  if (segments.length === 0) return { status: 'ok', corrections: new Map() };

  const userContent = JSON.stringify(segments);
  try {
    const result = await createGroqTextClient().chat({
      messages: [
        { role: 'system', content: CORRECTION_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      maxTokens: Math.min(2048, estimateTokens(userContent) * 2 + 64),
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal: opts.signal,
    });
    const corrections = parseCorrectionResponse(result.content, segments);
    if (!corrections) {
      logSkipped('unparseable', segments.length);
      return { status: 'skipped', reason: 'unparseable' };
    }
    console.log(`[groqText] ok: ${corrections.size}/${segments.length} segment(s) changed`);
    return { status: 'ok', corrections };
  } catch (err) {
    if (err instanceof GroqTextSkipError) return { status: 'skipped', reason: err.reason };
    logSkipped('error', segments.length);
    return { status: 'skipped', reason: 'error' };
  }
}
