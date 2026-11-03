// Faithful TypeScript port of SplitVox's TranscriptMerger.cs (see
// D:\claude\SplitVox\SplitVox\app-windows\SplitVoxTranscription\TranscriptMerger.cs).
// Every constant, threshold, and function below mirrors the C# source
// line-for-line for the single-stream (imported media) path used by August.
// Do not re-tune the thresholds — they are copied exactly, not re-derived.

import type { MergedUtterance, MuteInterval, TranscriptSegment } from '../types.js';

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
  return mergeSingleStreamDetailed(segments).utterances;
}

export interface MergeResult { utterances: MergedUtterance[]; dropped: number; }

/// Same pipeline as mergeSingleStream, also reporting how many raw segments the no-speech gate, credit stripping and
/// dedupHallucinations removed (filler, blacklist, repeats) — a hallucination signal for confidenceScore.ts (AUG-152).
export function mergeSingleStreamDetailed(segments: TranscriptSegment[]): MergeResult {
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
  return { utterances: joinAdjacentSameRole(deduped), dropped: segments.length - deduped.length };
}

/// Shifts every segment by `offsetSec`, clamping at zero. Used to put a
/// server-captured system track and the browser mic track on one clock.
export function shiftSegments(segments: TranscriptSegment[], offsetSec: number): TranscriptSegment[] {
  if (!offsetSec) return segments;
  return segments.map((s) => ({
    ...s,
    start: Math.max(0, s.start + offsetSec),
    end: Math.max(0, s.end + offsetSec),
  }));
}

/// `systemOffsetMs` = systemCaptureStartedAt - micRecorderStartedAt (wall clock,
/// same machine). Positive → the system track started later, so its segments
/// move forward; negative → the mic started later, so mic segments move
/// forward. The earlier-starting track defines t=0, exactly as the browser
/// dual-recording path does implicitly.
export function alignDualSegments(
  micSegments: TranscriptSegment[],
  systemSegments: TranscriptSegment[],
  systemOffsetMs: number,
): { mic: TranscriptSegment[]; system: TranscriptSegment[] } {
  const offsetSec = (Number.isFinite(systemOffsetMs) ? systemOffsetMs : 0) / 1000;
  if (offsetSec > 0) return { mic: micSegments, system: shiftSegments(systemSegments, offsetSec) };
  if (offsetSec < 0) return { mic: shiftSegments(micSegments, -offsetSec), system: systemSegments };
  return { mic: micSegments, system: systemSegments };
}

/// Real call length of a dual-track session on the aligned timeline (AUG-125). alignDualSegments shifts the
/// later-starting track by |systemOffsetMs|, so each track ends at its own length plus its shift.
export function alignedDualDuration(micSec: number, systemSec: number, systemOffsetMs: number): number {
  const offsetSec = (Number.isFinite(systemOffsetMs) ? systemOffsetMs : 0) / 1000;
  return Math.max(micSec + Math.max(0, -offsetSec), systemSec + Math.max(0, offsetSec));
}

export const TRACK_MISMATCH_MIN_SEC = 60;
export const TRACK_MISMATCH_RATIO = 0.1;
export const TRACK_MISMATCH_TOLERANCE_SEC = 2;

/// Non-blocking notice when one dual-track file is much shorter than the other (>60 s or >10% of the longer one,
/// ignoring the ±2 s stop jitter). null when both lengths are unknown/zero or close enough.
export function describeTrackMismatch(micSec: number, systemSec: number): string | null {
  if (!(micSec > 0) || !(systemSec > 0)) return null;
  const diff = Math.abs(micSec - systemSec);
  const longer = Math.max(micSec, systemSec);
  if (diff <= TRACK_MISMATCH_TOLERANCE_SEC) return null;
  if (diff <= TRACK_MISMATCH_MIN_SEC && diff <= TRACK_MISMATCH_RATIO * longer) return null;
  if (micSec < systemSec) {
    return `Mic track is shorter than system audio (${formatTimestamp(micSec)} vs ${formatTimestamp(systemSec)}) — [Me] lines stop after ${formatTimestamp(micSec)}.`;
  }
  return `System audio track is shorter than mic (${formatTimestamp(systemSec)} vs ${formatTimestamp(micSec)}) — [Them] lines stop after ${formatTimestamp(systemSec)}.`;
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
  return mergeDualStreamDetailed(micSegments, systemSegments).utterances;
}

/// Same pipeline as mergeDualStream, also reporting the number of raw segments dropped (AUG-152).
export function mergeDualStreamDetailed(
  micSegments: TranscriptSegment[],
  systemSegments: TranscriptSegment[],
): MergeResult {
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
  return {
    utterances: joinAdjacentSameRole(deduped),
    dropped: micSegments.length + systemSegments.length - deduped.length,
  };
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

export const MAX_MUTE_INTERVALS = 1000;

/// AUG-181: validates the client's muteIntervals form field (JSON string or array). Drops malformed entries, sorts, merges overlaps.
export function parseMuteIntervals(raw: unknown): MuteInterval[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const valid: MuteInterval[] = [];
  for (const entry of value) {
    if (valid.length >= MAX_MUTE_INTERVALS) break;
    if (!entry || typeof entry !== 'object') continue;
    const { startMs, endMs } = entry as { startMs?: unknown; endMs?: unknown };
    if (typeof startMs !== 'number' || typeof endMs !== 'number') continue;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (startMs < 0 || endMs <= startMs) continue;
    valid.push({ startMs: Math.round(startMs), endMs: Math.round(endMs) });
  }
  valid.sort((a, b) => a.startMs - b.startMs);
  const merged: MuteInterval[] = [];
  for (const interval of valid) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/// AUG-181: drops segments that lie mostly (>= 50 % of their length) inside a mute range. offsetSec is the shift already
/// applied to these segments by alignDualSegments, so the ranges move with them.
export function dropMutedSegments(
  segments: TranscriptSegment[],
  intervals: MuteInterval[],
  offsetSec = 0,
): TranscriptSegment[] {
  if (intervals.length === 0) return segments;
  const ranges = intervals.map((i) => ({ s: i.startMs / 1000 + offsetSec, e: i.endMs / 1000 + offsetSec }));
  return segments.filter((seg) => {
    const length = seg.end - seg.start;
    if (length <= 0) {
      return !ranges.some((r) => seg.start >= r.s && seg.start <= r.e);
    }
    let overlap = 0;
    for (const r of ranges) {
      overlap += Math.max(0, Math.min(seg.end, r.e) - Math.max(seg.start, r.s));
    }
    return overlap < 0.5 * length;
  });
}

/// AUG-181: mic shift (seconds) alignDualSegments applies to mic segments: the mic moves forward only when it started later.
export function micShiftSec(systemOffsetMs: number): number {
  return Math.max(0, -(Number.isFinite(systemOffsetMs) ? systemOffsetMs : 0) / 1000);
}

/// Total minutes (not wrapped at the hour) as mm:ss, e.g. 75:03.
export function formatGapClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function muteGapLine(startSec: number, endSec: number): string {
  return `— mic muted ${formatGapClock(startSec)}–${formatGapClock(endSec)} —`;
}

/// Renders utterances as transcript.md: a header followed by one
/// `[HH:MM:SS] text` line per utterance (`[HH:MM:SS] [Me]/[Them] text` when
/// utterances carry roles). Direct port of TranscriptMerger.cs's
/// RenderSingleStream. The header is always exactly Date + Duration: the
/// server-capture alignment offset (session.systemOffsetMs) is applied by
/// alignDualSegments before merging and is deliberately not printed here —
/// it is a diagnostic that belongs in session.json, not in a user-facing transcript.
/// AUG-181: muteGaps add `— mic muted mm:ss–mm:ss —` marker lines between utterances. They deliberately carry no
/// `[HH:MM:SS]` prefix: transcriptCorrections.ts and the client count timestamp lines as utterance indexes.
export function renderTranscript(
  utterances: MergedUtterance[],
  startedAt: string,
  duration: number,
  muteGaps: Array<{ startSec: number; endSec: number }> = [],
): string {
  const date = new Date(startedAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? startedAt
    : date.toLocaleString();

  const lines = ['# Transcript', '', `- Date: ${dateLabel}`, `- Duration: ${formatTimestamp(duration)}`, ''];

  const gaps = [...muteGaps].sort((a, b) => a.startSec - b.startSec);
  let gapIndex = 0;
  for (const utterance of utterances) {
    while (gapIndex < gaps.length && utterance.start >= gaps[gapIndex].startSec) {
      lines.push(muteGapLine(gaps[gapIndex].startSec, gaps[gapIndex].endSec));
      gapIndex++;
    }
    const rolePrefix = utterance.role ? `[${utterance.role}] ` : '';
    lines.push(`[${formatTimestamp(utterance.start)}] ${rolePrefix}${utterance.text}`);
  }
  for (; gapIndex < gaps.length; gapIndex++) {
    lines.push(muteGapLine(gaps[gapIndex].startSec, gaps[gapIndex].endSec));
  }

  return lines.join('\n') + '\n';
}
