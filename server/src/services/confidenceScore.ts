import type { ConfidenceDetail, TranscriptSegment } from '../types.js';

/// AUG-152 — transcription confidence (0–100) from whisper's own per-segment signals, no LLM involved.
/// base       = duration-weighted mean of (1 − no_speech_prob) when the binary exports it, else 1.
/// penalties  = 40 × duration share of segments with avg_logprob < −1.0
///            + min(30, 100 × dropped / rawSegments)            (merger hallucination/filler/repeat drops)
///            + 30 × max(0, (0.5 − coverage) / 0.5)             (transcribed seconds / audio seconds, VAD leaves silence out)
/// An empty transcript scores 0. Thresholds are the task's; do not retune without re-validating on known audio.
export const CONFIDENCE = {
  lowLogProb: -1.0,
  logProbPenalty: 40,
  hallucinationPenalty: 30,
  coveragePenalty: 30,
  coverageFloor: 0.5,
} as const;

export interface ConfidenceInput {
  /// Raw whisper segments per track (one array for single-track, mic + system for dual-track), before merging.
  tracks: TranscriptSegment[][];
  /// Segments the merger dropped (MergeResult.dropped).
  dropped: number;
  /// Real audio length in seconds (session.duration); 0 when unknown → coverage is not penalised.
  audioDurationSec: number;
}

export interface ConfidenceResult { score: number; detail: ConfidenceDetail; }

const round3 = (n: number) => Math.round(n * 1000) / 1000;

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
  const score = Math.round(Math.min(100, Math.max(0, 100 * noSpeechBase - penalty)));
  const source: ConfidenceDetail['source'] = hasNoSpeech ? 'no-speech-prob' : hasLogProb ? 'token-logprob' : 'coverage-only';
  return {
    score,
    detail: { source, segments: n, dropped, coverage: round3(coverage), lowLogProbShare: round3(lowLogProbShare), noSpeechBase: round3(noSpeechBase) },
  };
}
