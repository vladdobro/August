import type { ConfidenceDetail, PerplexitySummary, SemanticFlag, SemanticSegmentDetail, TranscriptSegment, TranscriptionLanguage } from '../types.js';
import { analyzeSegments } from './textStats.js';

/// AUG-152 — transcription confidence (0–100) from whisper's own per-segment signals, no LLM involved.
/// base       = duration-weighted mean of (1 − no_speech_prob) when the binary exports it, else 1.
/// penalties  = 40 × duration share of segments with avg_logprob < −1.0
///            + min(30, 100 × dropped / rawSegments)            (merger hallucination/filler/repeat drops)
///            + 30 × max(0, (0.5 − coverage) / 0.5)             (transcribed seconds / audio seconds, VAD leaves silence out)
/// semantic   = min(50, 40 × duration share of text-flagged segments + 30 × share flagged only by perplexity
///              + min(30, 15 × loop segments) + 25 when the session median PPL > 600) is subtracted on top
///              (AUG-163, textStats.ts / semanticCheck.ts); penalties only, so score ≤ acousticScore always.
/// An empty transcript scores 0. Thresholds are the task's; do not retune without re-validating on known audio.
export const CONFIDENCE = {
  lowLogProb: -1.0,
  logProbPenalty: 40,
  hallucinationPenalty: 30,
  coveragePenalty: 30,
  coverageFloor: 0.5,
} as const;

export const SEMANTIC = {
  textPenalty: 40, // × duration share of segments with any text flag
  pplPenalty: 30, // × duration share of segments flagged only by perplexity
  loopPenalty: 15, // per 'loop' segment — a loop is short on the timeline, so the duration share alone barely moves the score
  loopMaxPenalty: 30,
  // Session median PPL above this = the whole decode is off (ru audio decoded as en: median 1027 vs 149 clean ru, 48 clean en
  // on Qwen2.5-3B). The relative k × median rule cannot see a uniformly bad session.
  pplMedianCeiling: 600,
  pplMedianPenalty: 25,
  pplCeilingMinScored: 5,
  maxPenalty: 50,
} as const; // Do not retune without re-validating on reference sessions (AUG-163). Penalties only — never a bonus.

export interface ConfidenceInput {
  /// Raw whisper segments per track (one array for single-track, mic + system for dual-track), before merging.
  tracks: TranscriptSegment[][];
  /// Segments the merger dropped (MergeResult.dropped).
  dropped: number;
  /// Real audio length in seconds (session.duration); 0 when unknown → coverage is not penalised.
  audioDurationSec: number;
  /// AUG-163: session language, used by the wrong-alphabet check (default 'auto').
  language?: TranscriptionLanguage;
  /// AUG-163: perplexity pass output (semanticCheck.ts); absent when the local model is off or unavailable.
  perplexity?: {
    perTrack: Array<Array<number | null>>;
    flagged: Array<Array<boolean>>;
    summary?: PerplexitySummary;
    error?: string;
  };
}

export interface ConfidenceResult { score: number; detail: ConfidenceDetail; }

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const roundOrNull = (n: number | null) => (n === null ? null : round3(n));

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const segments = input.tracks.flat();
  const n = segments.length;
  const dropped = Math.max(0, input.dropped);
  if (n === 0) {
    return { score: 0, detail: { source: 'coverage-only', segments: 0, dropped, coverage: 0, lowLogProbShare: 0, noSpeechBase: 0 } };
  }
  const hasNoSpeech = segments.some((s) => typeof s.noSpeechProb === 'number');
  const hasLogProb = segments.some((s) => typeof s.avgLogProb === 'number');

  let weightSum = 0;
  let speechWeighted = 0;
  let lowWeighted = 0;
  for (const s of segments) {
    const w = Math.max(0.1, s.end - s.start);
    weightSum += w;
    const noSpeech = typeof s.noSpeechProb === 'number' ? Math.min(1, Math.max(0, s.noSpeechProb)) : 0;
    speechWeighted += w * (1 - noSpeech);
    if (typeof s.avgLogProb === 'number' && s.avgLogProb < CONFIDENCE.lowLogProb) lowWeighted += w;
  }
  const noSpeechBase = hasNoSpeech ? speechWeighted / weightSum : 1;
  const lowLogProbShare = hasLogProb ? lowWeighted / weightSum : 0;

  let coverage = 1;
  if (input.audioDurationSec > 0) {
    let transcribed = 0;
    for (const track of input.tracks) {
      const trackSec = track.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
      transcribed += Math.min(trackSec, input.audioDurationSec);
    }
    coverage = Math.min(1, transcribed / input.audioDurationSec);
  }

  const dropRatio = dropped / n; // n = raw segment count the merger saw
  const penalty =
    CONFIDENCE.logProbPenalty * lowLogProbShare +
    Math.min(CONFIDENCE.hallucinationPenalty, 100 * dropRatio) +
    CONFIDENCE.coveragePenalty * Math.max(0, (CONFIDENCE.coverageFloor - coverage) / CONFIDENCE.coverageFloor);
  const acousticScore = Math.round(Math.min(100, Math.max(0, 100 * noSpeechBase - penalty)));

  // AUG-163: semantic term — text statistics always, perplexity when the local model scored the segments.
  const stats = analyzeSegments(input.tracks, input.language ?? 'auto');
  let textWeighted = 0;
  let pplOnlyWeighted = 0;
  const flaggedSegments: SemanticSegmentDetail[] = [];
  input.tracks.forEach((track, t) => {
    track.forEach((s, i) => {
      const w = Math.max(0.1, s.end - s.start);
      const st = stats[t]?.[i];
      const textFlagged = !!st && st.flags.length > 0;
      const pplFlagged = input.perplexity?.flagged[t]?.[i] === true;
      if (textFlagged) textWeighted += w;
      else if (pplFlagged) pplOnlyWeighted += w;
      if (!st || (!textFlagged && !pplFlagged)) return;
      const flags: SemanticFlag[] = pplFlagged ? [...st.flags, 'perplexity'] : [...st.flags];
      const ppl = input.perplexity?.perTrack[t]?.[i];
      const entry: SemanticSegmentDetail = {
        track: t,
        index: i,
        start: round3(s.start),
        end: round3(s.end),
        flags,
        compressionRatio: round3(st.compressionRatio),
        oovRatio: roundOrNull(st.oovRatio),
        stopWordRatio: roundOrNull(st.stopWordRatio),
        wordsPerSec: roundOrNull(st.wordsPerSec),
        tokenDips: st.tokenDips,
      };
      if (typeof ppl === 'number' && Number.isFinite(ppl)) entry.perplexity = Math.round(ppl * 10) / 10;
      flaggedSegments.push(entry);
    });
  });
  const textShare = textWeighted / weightSum;
  const pplOnlyShare = pplOnlyWeighted / weightSum;
  const loops = flaggedSegments.filter((s) => s.flags.includes('loop')).length;
  const summary = input.perplexity?.summary;
  const pplCeilingHit = !!summary && summary.scored >= SEMANTIC.pplCeilingMinScored && summary.medianPpl > SEMANTIC.pplMedianCeiling;
  const semanticPenalty = Math.min(
    SEMANTIC.maxPenalty,
    SEMANTIC.textPenalty * textShare +
      SEMANTIC.pplPenalty * pplOnlyShare +
      Math.min(SEMANTIC.loopMaxPenalty, SEMANTIC.loopPenalty * loops) +
      (pplCeilingHit ? SEMANTIC.pplMedianPenalty : 0),
  );
  const score = Math.min(
    acousticScore,
    Math.round(Math.min(100, Math.max(0, 100 * noSpeechBase - penalty - semanticPenalty))),
  );
  const semantic: NonNullable<ConfidenceDetail['semantic']> = {
    penalty: round3(semanticPenalty),
    textFlaggedShare: round3(textShare),
    pplFlaggedShare: round3(pplOnlyShare),
    loops,
    pplCeilingHit,
    segments: flaggedSegments,
  };
  if (input.perplexity?.summary) semantic.perplexity = input.perplexity.summary;
  if (input.perplexity?.error) semantic.perplexityError = input.perplexity.error;
  const source: ConfidenceDetail['source'] = hasNoSpeech ? 'no-speech-prob' : hasLogProb ? 'token-logprob' : 'coverage-only';
  return {
    score,
    detail: {
      source, segments: n, dropped, coverage: round3(coverage), lowLogProbShare: round3(lowLogProbShare), noSpeechBase: round3(noSpeechBase),
      acousticScore, semantic,
    },
  };
}
