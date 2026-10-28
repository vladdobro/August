import React from 'react';

export type ConfidenceTier = 'ok' | 'warn' | 'bad';

/// AUG-152 colour bands: green ≥ 80, amber 60–79, red < 60.
export function confidenceTier(score: number): ConfidenceTier {
  return score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'bad';
}

interface ConfidenceBadgeProps {
  score: number;
  /// Append the word "confidence" (transcript header); the sidebar shows the bare percentage.
  withLabel?: boolean;
}

const ConfidenceBadge: React.FC<ConfidenceBadgeProps> = ({ score, withLabel = false }) => (
  <span
    className={`confidence-badge confidence-badge--${confidenceTier(score)}`}
    title="Transcription confidence from whisper's token probabilities, how much of the audio produced text, and how many segments were filtered as hallucinations"
  >
    {score}%{withLabel ? ' confidence' : ''}
  </span>
);

export default ConfidenceBadge;
