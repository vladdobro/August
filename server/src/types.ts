export type TranscriptionLanguage = 'auto' | 'en' | 'ru';

export type SessionStatus = 'uploading' | 'preparing' | 'transcribing' | 'completed' | 'failed';

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
  // Dual-track only (AUG-125): ffprobe length of each 16 kHz WAV in seconds.
  trackDurations?: { mic: number; system: number };
  // Dual-track only (AUG-125): non-blocking notice when one track is much shorter than the other.
  trackWarning?: string;
  sourceUrl?: string;
  downloadProgress?: number;
  // AUG-150: set when every audio file was removed from the Archive page; transcript.md and session.json remain.
  audioDeletedAt?: string;
  // AUG-150: audio files removed from the Archive page (name + size at deletion), shown struck-through in the breakdown.
  audioDeletedFiles?: Array<{ name: string; bytes: number; auto?: boolean }>;
  // AUG-152: 0–100 transcription confidence computed after whisper finishes (services/confidenceScore.ts).
  confidenceScore?: number;
  // AUG-152: diagnostic breakdown behind confidenceScore — kept in session.json, never shown in the UI.
  confidenceDetail?: ConfidenceDetail;
  // AUG-152: set when the converted WAV(s) were removed automatically after a confident transcription; source audio stays.
  wavAutoDeletedAt?: string;
}

/// AUG-152: how confidenceScore was derived. 'no-speech-prob' when the binary exported no_speech_prob, 'token-logprob'
/// when only per-token probabilities were available (whisper-cli 1.8.4), 'coverage-only' when neither was.
export interface ConfidenceDetail {
  source: 'no-speech-prob' | 'token-logprob' | 'coverage-only';
  segments: number;
  dropped: number;
  coverage: number;
  lowLogProbShare: number;
  noSpeechBase: number;
}

export type SessionSource = 'recording' | 'upload' | 'link' | 'platform';
export type StorageFileKind = 'audio' | 'transcript' | 'meta' | 'other';
export interface SessionStorageFile { name: string; bytes: number; kind: StorageFileKind; note?: 'original' | 'converted' | 'boosted'; deleted?: boolean; auto?: boolean; }
export interface SessionStorageEntry { id: string; title: string; createdAt: string; status: SessionStatus; source: SessionSource; sourceUrl?: string; error?: string; totalBytes: number; audioBytes: number; audioDeleted: boolean; wavAutoDeleted: boolean; files: SessionStorageFile[]; }
export interface StorageSummary { sessionsDir: string; totalBytes: number; sessions: SessionStorageEntry[]; }

export interface TranscriptSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
  noSpeechProb?: number;
  // mean ln(token p) over the segment's non-special tokens (AUG-152), or whisper's avg_logprob when exported
  avgLogProb?: number;
}

export interface WhisperJsonOutput {
  transcription: Array<{
    timestamps: { from: string; to: string };
    offsets: { from: number; to: number };
    text: string;
    no_speech_prob?: number;
    avg_logprob?: number;
    tokens?: Array<{ text: string; id?: number; p: number }>;
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
