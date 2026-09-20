export type TranscriptionLanguage = 'auto' | 'en' | 'ru';

export type SessionStatus = 'uploading' | 'transcribing' | 'completed' | 'failed';

export interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string; // ISO
  duration: number; // seconds
  language: TranscriptionLanguage;
  status: SessionStatus;
  originalFileName?: string;
  error?: string;
  dualTrack?: boolean;
  transcriptionStartedAt?: string;
  transcriptionProgress?: number;
  estimatedDuration?: number;
  // Wall-clock offset (ms) of the server-captured system track relative to the browser mic track:
  // positive = system capture started later than the mic recorder. Used to align segments before merge.
  systemOffsetMs?: number;
}

export interface TranscriptSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
  noSpeechProb?: number;
}

export interface WhisperJsonOutput {
  transcription: Array<{
    timestamps: { from: string; to: string };
    offsets: { from: number; to: number };
    text: string;
    no_speech_prob?: number;
  }>;
}

export interface MergedUtterance {
  start: number;
  end: number;
  text: string;
  role?: string;
}

export type CaptureMethod = 'coreaudio-tap' | 'blackhole' | 'wasapi-loopback' | 'dshow-loopback' | 'none';

/// Result of the ~1 s probe capture (AUG-106, Windows added in AUG-111):
/// 'ok' audio was captured and is non-silent; 'silent' capture ran but mean volume was below the silence threshold;
/// 'failed' capture process errored or produced no usable file; 'skipped' unsupported platform, no method detected, or a capture was already running.
export type CaptureSelfTest = 'ok' | 'silent' | 'failed' | 'skipped';

export interface CaptureCapabilities {
  systemCapture: boolean;
  method: CaptureMethod;
  platform: string;
  hint: string;
  // coreaudio-tap only (AUG-107): raw PCM format audiotee writes to stdout and how it was decided —
  // 'override' = AUDIOTEE_SAMPLE_FORMAT, 'detected' = sniffed from a probe, 'fallback' = probe unusable, s16le assumed.
  sampleFormat?: string;
  sampleFormatSource?: 'override' | 'detected' | 'fallback';
  selfTest: CaptureSelfTest;
  selfTestDetail: string;
}
