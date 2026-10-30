import type { CorrectionItem, MergedUtterance, PerplexitySummary, TranscriptSegment, TranscriptionLanguage } from '../types.js';
import { computeConfidence, type ConfidenceInput, type ConfidenceResult } from './confidenceScore.js';
import type { LlmClient } from './llmClient.js';
import { llmInstallState, readLlmSettings } from './llmInstaller.js';
import { LlmUnavailableError, withLocalLlm } from './llmServer.js';
import { createGroqTextClient, GROQ_TEXT_MODEL, groqTextState } from './groqText.js';
import { readPreferences, type PreferencesRecord } from './preferencesStore.js';
import { tokenizeWords } from './textStats.js';
import { withBatchSlot } from './whisper.js';

/// AUG-163 — post-whisper semantic pass on the local model: perplexity outliers (scoring) and optional meaning
/// corrections (suggestions only). Runs inside the batch slot. Values stay in session.json / logs, never in the UI.

export const PERPLEXITY = {
  k: 4, // segment flagged when PPL > k x session median PPL
  minWords: 3, // shorter segments are not scored
  minScored: 5, // fewer scored segments -> no median, nothing flagged
  timeBudgetMs: 240_000,
  requestTimeoutMs: 30_000,
} as const; // Do not retune without re-validating on reference sessions (AUG-163).

export const CORRECTIONS = {
  maxItems: 40,
  maxChars: 1200, // longer utterances are skipped
  timeBudgetMs: 180_000,
  requestTimeoutMs: 60_000,
  minSimilarity: 0.6, // normalized char-level similarity original <-> suggestion; below = rewrite, discarded
} as const; // Do not retune without re-validating (AUG-163).

const CORRECTION_SYSTEM_PROMPT = `You fix speech-recognition errors in one transcript line.
Rules:
- Fix only words that were clearly misheard (a similar-sounding wrong word, a broken word, a word in the wrong alphabet).
- Do not add, remove, reorder or summarise information. Do not translate. Keep the original language, wording and punctuation style.
- If you are not sure, return the line exactly as it is.
- Reply with the corrected line only, without quotes or comments.`;

async function localModelReady(): Promise<boolean> {
  try {
    const s = await readLlmSettings();
    return s.enabled && (await llmInstallState(s.model)) === 'ready';
  } catch {
    return false;
  }
}

export type CorrectionEngine = 'local' | 'groq';

/// AUG-164: who fixes flagged lines. The local model needs llmCorrections; Groq needs Online text correction with a valid
/// consent. Both on → prefs.batchCorrectionEngine ('local' by default); otherwise whichever is on; neither → null.
export function resolveCorrectionEngine(prefs: PreferencesRecord, localReady: boolean): CorrectionEngine | null {
  const local = localReady && prefs.llmCorrections === true;
  const groq = groqTextState(prefs).enabled;
  if (local && groq) return prefs.batchCorrectionEngine === 'groq' ? 'groq' : 'local';
  return local ? 'local' : groq ? 'groq' : null;
}

/// Model id recorded in transcript.corrected.json when Groq produced the suggestions.
export const GROQ_CORRECTION_MODEL = `groq/${GROQ_TEXT_MODEL}`;

/// JSON string escapes are valid GBNF; control characters are flattened to spaces first.
export function gbnfLiteral(s: string): string {
  return JSON.stringify(s.replace(/[\u0000-\u001f\u007f]/g, ' '));
}

export interface PerplexityOutput {
  perTrack: Array<Array<number | null>>;
  flagged: Array<Array<boolean>>;
  summary?: PerplexitySummary;
}

/// Segments whose PPL exceeds k x the median of all scored PPLs; nothing is flagged below minScored scored segments.
export function flagPerplexityOutliers(
  perTrack: Array<Array<number | null>>,
  k: number,
  minScored: number,
): { flagged: boolean[][]; median: number | null } {
  const values = perTrack.flat().filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length < minScored || values.length === 0) {
    return { flagged: perTrack.map((t) => t.map(() => false)), median: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    flagged: perTrack.map((t) => t.map((v) => typeof v === 'number' && Number.isFinite(v) && v > k * median)),
    median,
  };
}

/// Perplexity of every segment under the local model, with the previous two segments of the same track as context.
/// llama-server does not echo prompt logprobs, so the segment is forced as the continuation through a GBNF grammar and
/// the raw model logprob of each forced token is read back.
export async function scorePerplexity(
  client: LlmClient,
  tracks: TranscriptSegment[][],
  model: string,
  isCancelled?: () => boolean,
): Promise<PerplexityOutput & { summary: PerplexitySummary }> {
  const startedAt = Date.now();
  const perTrack: Array<Array<number | null>> = tracks.map((t) => t.map(() => null));
  let scored = 0;
  let skipped = 0;
  let failed = 0;
  let stopped = false;

  for (let t = 0; t < tracks.length && !stopped; t++) {
    const track = tracks[t];
    for (let i = 0; i < track.length; i++) {
      const text = (track[i].text ?? '').trim();
      if (tokenizeWords(text).length < PERPLEXITY.minWords) continue;
      if (isCancelled?.() || Date.now() - startedAt > PERPLEXITY.timeBudgetMs) { stopped = true; }
      if (stopped) { skipped += 1; continue; }
      const prefix = track.slice(Math.max(0, i - 2), i).map((s) => (s.text ?? '').trim()).filter(Boolean).join(' ') || 'Transcript:';
      try {
        const res = await client.complete({
          prompt: prefix,
          maxTokens: 256,
          temperature: 0,
          logprobs: 1,
          grammar: `root ::= ${gbnfLiteral(` ${text}`)}`,
          timeoutMs: PERPLEXITY.requestTimeoutMs,
        });
        const lps = (res.logprobs ?? []).filter((e) => e.token !== '').map((e) => e.logprob);
        if (lps.length === 0) { skipped += 1; continue; }
        perTrack[t][i] = Math.exp(-lps.reduce((a, b) => a + b, 0) / lps.length);
        scored += 1;
      } catch {
        failed += 1;
        skipped += 1;
      }
    }
  }
  if (failed > 0) console.warn(`[semantic] perplexity: ${failed} segment request(s) failed and were skipped`);

  const { flagged, median } = flagPerplexityOutliers(perTrack, PERPLEXITY.k, PERPLEXITY.minScored);
  return {
    perTrack,
    flagged,
    summary: {
      model,
      medianPpl: median === null ? 0 : Math.round(median * 10) / 10,
      k: PERPLEXITY.k,
      scored,
      skipped,
      ms: Date.now() - startedAt,
    },
  };
}

/// Utterances overlapping a flagged segment of the same role (undefined role on both sides for single-track).
export function mapFlagsToUtterances(
  utterances: MergedUtterance[],
  flaggedSegments: Array<{ start: number; end: number; role?: string }>,
): number[] {
  const out = new Set<number>();
  utterances.forEach((u, idx) => {
    for (const seg of flaggedSegments) {
      if ((seg.role ?? undefined) !== (u.role ?? undefined)) continue;
      const overlap = Math.min(u.end, seg.end) - Math.max(u.start, seg.start);
      if (overlap > 0 || (seg.start >= u.start && seg.start <= u.end)) { out.add(idx); break; }
    }
  });
  return [...out].sort((a, b) => a - b);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

const QUOTE_PAIRS: Array<[string, string]> = [['«', '»'], ['"', '"'], ["'", "'"], ['“', '”']];

/// Guards against model drift: the suggestion must be a small edit of the original that does not add words.
export function acceptSuggestion(original: string, suggested: string): string | null {
  let text = suggested.trim().replace(/^(?:Line|Corrected)\s*:\s*/i, '').trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) { text = text.slice(1, -1).trim(); break; }
  }
  if (!text) return null;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (norm(text) === norm(original)) return null;
  if (tokenizeWords(text).length > tokenizeWords(original).length) return null;
  const a = norm(original).toLowerCase();
  const b = norm(text).toLowerCase();
  const similarity = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
  if (similarity < CORRECTIONS.minSimilarity) return null;
  return text;
}

/// A flagged whisper segment located inside a transcript line. Single-track lines merge many segments, so the fix
/// targets the segment's text, not the whole line.
export interface CorrectionTarget {
  index: number; // utterance index
  start: number;
  role: string | null;
  text: string; // segment text, found verbatim inside utterances[index].text
  prev: string | null; // neighbouring segments of the same track, as context
  next: string | null;
}

/// Flagged segments → targets: the utterance (same role, overlapping time) whose text contains the segment text verbatim.
/// Segments the merger altered or dropped have no such line and are skipped; duplicates are collapsed.
export function buildCorrectionTargets(
  tracks: TranscriptSegment[][],
  utterances: MergedUtterance[],
  flagged: Array<{ track: number; index: number }>,
): CorrectionTarget[] {
  const dual = tracks.length > 1;
  const seen = new Set<string>();
  const targets: CorrectionTarget[] = [];
  for (const f of flagged) {
    const track = tracks[f.track];
    const seg = track?.[f.index];
    const text = (seg?.text ?? '').trim();
    if (!seg || !text) continue;
    const role = dual ? (f.track === 0 ? 'Me' : 'Them') : undefined;
    const idx = mapFlagsToUtterances(utterances, [{ start: seg.start, end: seg.end, role }])
      .find((u) => utterances[u].text.includes(text));
    if (idx === undefined) continue;
    const key = `${idx}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      index: idx,
      start: seg.start,
      role: role ?? null,
      text,
      prev: f.index > 0 ? (track[f.index - 1].text ?? '').trim() || null : null,
      next: f.index + 1 < track.length ? (track[f.index + 1].text ?? '').trim() || null : null,
    });
  }
  return targets.sort((a, b) => a.index - b.index || a.start - b.start);
}

/// One chat call per flagged segment; only suggestions that pass acceptSuggestion are returned (status 'pending').
export async function suggestCorrections(
  client: LlmClient,
  targets: CorrectionTarget[],
  isCancelled?: () => boolean,
): Promise<CorrectionItem[]> {
  const startedAt = Date.now();
  const items: CorrectionItem[] = [];
  for (const target of targets) {
    if (items.length >= CORRECTIONS.maxItems) break;
    if (isCancelled?.() || Date.now() - startedAt > CORRECTIONS.timeBudgetMs) break;
    const { text, prev, next } = target;
    if (text.length > CORRECTIONS.maxChars) continue;
    try {
      const res = await client.chat({
        messages: [
          { role: 'system', content: CORRECTION_SYSTEM_PROMPT },
          { role: 'user', content: `Previous line: ${prev ?? '(none)'}\nNext line: ${next ?? '(none)'}\n\nLine to fix:\n${text}` },
        ],
        temperature: 0,
        maxTokens: Math.min(512, Math.ceil(text.length / 2) + 32),
        timeoutMs: CORRECTIONS.requestTimeoutMs,
      });
      const accepted = acceptSuggestion(text, res.content);
      if (accepted) {
        items.push({ id: items.length, index: target.index, start: target.start, role: target.role, original: text, suggested: accepted, status: 'pending' });
      }
    } catch {
      // a failed request only skips this line
    }
  }
  return items;
}

export interface SemanticPassInput {
  sessionId: string;
  tracks: TranscriptSegment[][];
  utterances: MergedUtterance[];
  dropped: number;
  audioDurationSec: number;
  language: TranscriptionLanguage;
  isCancelled?: () => boolean;
}

export interface SemanticPassResult {
  confidence: ConfidenceResult;
  corrections: CorrectionItem[] | null;
  /// Model that produced the corrections (local model id, or GROQ_CORRECTION_MODEL); for the local pass also when only scoring ran; null when nothing ran.
  model: string | null;
}

/// AUG-164: same targets, prompt and acceptSuggestion guard as the local path, on Groq's free tier. Never throws: a
/// skipped request (limit, 429, network) only drops that line.
async function suggestGroqCorrections(input: SemanticPassInput, confidence: ConfidenceResult): Promise<CorrectionItem[]> {
  const targets = buildCorrectionTargets(input.tracks, input.utterances, confidence.detail.semantic?.segments ?? []);
  if (targets.length === 0) return [];
  return suggestCorrections(createGroqTextClient({ waitForBudgetMs: 60_000 }), targets, input.isCancelled);
}

/// Computes the confidence score including the semantic term. Never throws: any local-model failure falls back to the
/// text-statistics-only score with the reason recorded in detail.semantic.perplexityError.
export async function runSemanticPass(input: SemanticPassInput): Promise<SemanticPassResult> {
  const base: ConfidenceInput = {
    tracks: input.tracks,
    dropped: input.dropped,
    audioDurationSec: input.audioDurationSec,
    language: input.language,
  };
  const localReady = await localModelReady();
  const engine = resolveCorrectionEngine(await readPreferences(), localReady);
  if (!localReady) {
    const confidence = computeConfidence(base);
    if (engine !== 'groq' || input.isCancelled?.()) return { confidence, corrections: null, model: null };
    const corrections = await suggestGroqCorrections(input, confidence);
    console.log(`[session ${input.sessionId}] semantic: groq corrections ${corrections.length}`);
    return { confidence, corrections, model: GROQ_CORRECTION_MODEL };
  }

  let corrections: CorrectionItem[] | null = null;
  let model: string | null = null;
  try {
    const confidence = await withBatchSlot(() => withLocalLlm(async (client, modelId) => {
      model = modelId;
      const ppl = await scorePerplexity(client, input.tracks, modelId, input.isCancelled);
      const result = computeConfidence({ ...base, perplexity: ppl });
      if (engine === 'local' && !input.isCancelled?.()) {
        const targets = buildCorrectionTargets(input.tracks, input.utterances, result.detail.semantic?.segments ?? []);
        corrections = targets.length > 0 ? await suggestCorrections(client, targets, input.isCancelled) : [];
      }
      return result;
    }));
    if (engine === 'groq' && !input.isCancelled?.()) {
      corrections = await suggestGroqCorrections(input, confidence);
      model = GROQ_CORRECTION_MODEL;
    }
    const sem = confidence.detail.semantic;
    const sum = sem?.perplexity;
    const segs = sem?.segments ?? [];
    console.log(
      `[session ${input.sessionId}] semantic: penalty ${sem?.penalty ?? 0}, ` +
      `text-flagged ${segs.filter((s) => s.flags.some((f) => f !== 'perplexity')).length}, ` +
      `ppl-flagged ${segs.filter((s) => s.flags.includes('perplexity')).length}` +
      (sum ? ` (median PPL ${sum.medianPpl}, scored ${sum.scored}/skipped ${sum.skipped}, ${sum.ms} ms)` : '') +
      `, corrections ${(corrections as CorrectionItem[] | null)?.length ?? 0}`,
    );
    return { confidence, corrections, model };
  } catch (err) {
    const message = err instanceof LlmUnavailableError || err instanceof Error ? err.message : String(err);
    console.warn(`[session ${input.sessionId}] semantic check skipped: ${message}`);
    const fallback = computeConfidence({ ...base, perplexity: { perTrack: [], flagged: [], error: message } });
    if (engine === 'groq' && !input.isCancelled?.()) {
      const groqItems = await suggestGroqCorrections(input, fallback);
      return { confidence: fallback, corrections: groqItems, model: GROQ_CORRECTION_MODEL };
    }
    return { confidence: fallback, corrections: null, model: null };
  }
}
