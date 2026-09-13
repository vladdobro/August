// Faithful TypeScript port of SplitVox's TranscriptMerger.cs (see
// D:\claude\SplitVox\SplitVox\app-windows\SplitVoxTranscription\TranscriptMerger.cs).
// Every constant, threshold, and function below mirrors the C# source
// line-for-line for the single-stream (imported media) path used by August.
// Do not re-tune the thresholds — they are copied exactly, not re-derived.

import type { MergedUtterance, TranscriptSegment } from '../types.js';

/// Segments whose normalized text is exactly one of these are dropped as
/// content-free filler (whisper.cpp's own bracketed-tag vocabulary,
/// normalized).
export const FILLER_ONLY_TEXTS = new Set<string>([
  'blank audio',
  'silence',
  'music',
  'typing',
  'inaudible',
  'no audio',
  'background noise',
]);

/// Ported as data, not re-implemented, from macOS's hallucinationBlacklist —
/// do not add a wording variant of the "subtitles credit" hallucination
/// here; see isHallucination.
const HALLUCINATION_BLACKLIST = new Set<string>([
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'продолжение следует',
  'спасибо за просмотр',
]);

const JOIN_GAP_THRESHOLD = 2.0;
const DEDUP_WINDOW = 30.0;
const NO_SPEECH_PROB_THRESHOLD = 0.6;

/// Regex patterns for the "Редактор субтитров А.Семкин Корректор А.Егорова"
/// credit-line hallucination. Applied in order: full line first, then individual
/// halves, so a complete credit line produces one [OOPS] not two.
const CREDIT_PATTERNS: RegExp[] = [
  /редактор\s+субтитров[\s.,;:]+(?:а[\s.,;:]*)?семкин[а-яёa-z]*[\s.,;:]+корректор[\s.,;:]+(?:а[\s.,;:]*)?егоров[а-яёa-z]*[.,;:]*/gi,
  /редактор\s+субтитров[\s.,;:]+(?:а[\s.,;:]*)?семкин[а-яёa-z]*[.,;:]*/gi,
  /корректор[\s.,;:]+(?:а[\s.,;:]*)?егоров[а-яёa-z]*[.,;:]*/gi,
];

/// Lowercases, replaces punctuation with whitespace (so "[BLANK_AUDIO]"
/// normalizes to the same thing as "blank audio"), and collapses whitespace,
/// so near-identical hallucinated segments compare equal. Direct port of
/// TranscriptMerger.swift/cs's Normalize.
export function normalize(text: string): string {
  const lowered = text.toLowerCase();
  let out = '';
  for (const ch of lowered) {
    out += /[\p{L}\p{N}]/u.test(ch) ? ch : ' ';
  }
  return out.split(/\s+/).filter((part) => part.length > 0).join(' ');
}

/// True when normalizedText (already run through normalize) is a known
/// whisper.cpp hallucination. The Russian "subtitles credit" hallucination
/// has multiple known verb wordings, so it is caught via normalized
/// co-occurrence of "субтитры" and "dimatorzok" rather than literal
/// enumeration — do not fix a future verb variant by adding another literal
/// phrase.
export function isHallucination(normalizedText: string): boolean {
  if (HALLUCINATION_BLACKLIST.has(normalizedText)) {
    return true;
  }
  return normalizedText.includes('субтитры') && normalizedText.includes('dimatorzok');
}

/// Replaces credit-line hallucination fragments with [OOPS] in the original
/// text. Returns cleaned text with collapsed whitespace and trimmed.
export function stripCreditHallucination(text: string): string {
  let result = text;
  for (const pattern of CREDIT_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[OOPS]');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/// Strips credit-line fragments from segments, replacing them with [OOPS].
/// Runs before dedup/join so cleaned segments participate correctly in merging.
function stripCreditLines(segments: MergedUtterance[]): MergedUtterance[] {
  const result: MergedUtterance[] = [];
  for (const seg of segments) {
    const stripped = stripCreditHallucination(seg.text);
    if (stripped.length === 0) continue;
    result.push({ ...seg, text: stripped });
  }
  return result;
}

/// Drops empty/filler segments, drops blacklisted hallucinations, and dedups
/// a segment whose normalized text repeats the previously kept segment's
/// normalized text within DEDUP_WINDOW seconds. Direct port of
/// TranscriptMerger.cs's DedupHallucinationsCounting (kept list only; August
/// has no need for the per-category drop counters SplitVox logs).
export function dedupHallucinations(segments: MergedUtterance[]): MergedUtterance[] {
  const kept: MergedUtterance[] = [];
  let lastKeptIndex = -1;

  for (const segment of segments) {
    const normalized = normalize(segment.text);

    if (normalized.length === 0 || FILLER_ONLY_TEXTS.has(normalized)) {
      continue;
    }
    if (isHallucination(normalized)) {
      continue;
    }

    if (lastKeptIndex >= 0) {
      const previous = kept[lastKeptIndex];
      const isRepeat = normalize(previous.text) === normalized;
      const withinWindow = segment.start - previous.start <= DEDUP_WINDOW;
      if (isRepeat && withinWindow) {
        continue;
      }
    }

    kept.push(segment);
    lastKeptIndex = kept.length - 1;
  }

  return kept;
}

/// Joins adjacent segments whose gap (next.start - previous.end) is less
/// than JOIN_GAP_THRESHOLD into a single paragraph-line utterance. Direct
/// port of TranscriptMerger.cs's JoinAdjacentSameRole, minus the role
/// comparison (August's single-stream transcripts have no role split).
export function joinAdjacentSameRole(segments: MergedUtterance[]): MergedUtterance[] {
  const output: MergedUtterance[] = [];

  for (const segment of segments) {
    if (output.length > 0) {
      const last = output[output.length - 1];
      if (segment.role === last.role && segment.start - last.end < JOIN_GAP_THRESHOLD) {
        output[output.length - 1] = {
          start: last.start,
          end: Math.max(last.end, segment.end),
          text: `${last.text} ${segment.text}`,
          role: last.role,
        };
        continue;
      }
    }
    output.push({ start: segment.start, end: segment.end, text: segment.text, role: segment.role });
  }

  return output;
}

/// Filters and joins one stream's decoded segments using the exact same
/// filler/blacklist/dedup/join rules SplitVox's Merge/MergeSingleStream
/// apply. Before the generic dedup pass, mirrors WhisperTranscriber.cs's
/// own no-speech gate (Layer 2): a segment whose whisper-reported
/// no_speech_prob exceeds NO_SPEECH_PROB_THRESHOLD *and* whose text is a
/// known hallucination is dropped outright. Direct port of
/// TranscriptMerger.swift/cs's mergeSingleStream, entry point for August's
/// single-track imported/recorded media (no mic/system split to diarize
/// by).
export function mergeSingleStream(segments: TranscriptSegment[]): MergedUtterance[] {
  const gated = segments.filter((segment) => {
    const noSpeechProb = segment.noSpeechProb ?? 0;
    if (noSpeechProb > NO_SPEECH_PROB_THRESHOLD && isHallucination(normalize(segment.text))) {
      return false;
    }
    return true;
  });

  const utterances: MergedUtterance[] = gated.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
  }));

  const cleaned = stripCreditLines(utterances);
  const deduped = dedupHallucinations(cleaned);
  return joinAdjacentSameRole(deduped);
}

/// Merges two independently-transcribed streams (mic + system audio) into a
/// single chronological, role-tagged utterance list. Each stream is gated
/// the same way mergeSingleStream gates its one stream, then the two
/// role-tagged utterance lists are combined, sorted by start time, deduped,
/// and joined — mirroring SplitVox's dual-stream (Me/Them) merge path.
export function mergeDualStream(
  micSegments: TranscriptSegment[],
  systemSegments: TranscriptSegment[],
): MergedUtterance[] {
  const gate = (s: TranscriptSegment) => {
    const prob = s.noSpeechProb ?? 0;
    return !(prob > NO_SPEECH_PROB_THRESHOLD && isHallucination(normalize(s.text)));
  };

  const micUtterances: MergedUtterance[] = micSegments.filter(gate).map((s) => ({
    start: s.start, end: s.end, text: s.text, role: 'Me',
  }));
  const systemUtterances: MergedUtterance[] = systemSegments.filter(gate).map((s) => ({
    start: s.start, end: s.end, text: s.text, role: 'Them',
  }));

  const combined = [...micUtterances, ...systemUtterances].sort((a, b) => a.start - b.start);
  const cleaned = stripCreditLines(combined);
  const deduped = dedupHallucinations(cleaned);
  return joinAdjacentSameRole(deduped);
}

/// Formats seconds as `HH:MM:SS`. Direct port of TranscriptMerger.cs's
/// FormatTimestamp.
export function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

/// Renders single-stream utterances as transcript.md: a header followed by
/// one `[HH:MM:SS] text` line per utterance (no role prefix, since
/// August's imported/recorded media is never split into Me/Them). Direct
/// port of TranscriptMerger.cs's RenderSingleStream.
export function renderTranscript(
  utterances: MergedUtterance[],
  startedAt: string,
  duration: number,
): string {
  const date = new Date(startedAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? startedAt
    : date.toLocaleString();

  const lines = ['# Transcript', '', `- Date: ${dateLabel}`, `- Duration: ${formatTimestamp(duration)}`, ''];

  for (const utterance of utterances) {
    const rolePrefix = utterance.role ? `[${utterance.role}] ` : '';
    lines.push(`[${formatTimestamp(utterance.start)}] ${rolePrefix}${utterance.text}`);
  }

  return lines.join('\n') + '\n';
}
