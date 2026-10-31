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
  participants?: { me: string; them: string }; // AUG-165: names for Me / Them entered at live recording start
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
  // AUG-163: the acoustic score before the semantic penalty; diagnostics only, never shown in the UI.
  acousticScore?: number;
  // AUG-163: text-statistics and perplexity findings; diagnostics only, never shown in the UI.
  semantic?: SemanticDetail;
}

/// AUG-163: why a segment was marked by the semantic check (textStats.ts / semanticCheck.ts).
export type SemanticFlag = 'loop' | 'oov' | 'stopwords' | 'script' | 'rate' | 'token-dip' | 'perplexity';

export interface SemanticSegmentDetail {
  track: number; // index into ConfidenceInput.tracks (0 = single / mic, 1 = system)
  index: number; // segment index within that track
  start: number;
  end: number;
  flags: SemanticFlag[];
  compressionRatio: number;
  oovRatio: number | null; // null when too few words to judge
  stopWordRatio: number | null;
  wordsPerSec: number | null;
  tokenDips: number;
  perplexity?: number;
}

export interface PerplexitySummary {
  model: string;
  medianPpl: number;
  k: number;
  scored: number;
  skipped: number;
  ms: number;
}

export interface SemanticDetail {
  penalty: number; // points subtracted from the acoustic score (>= 0)
  textFlaggedShare: number; // duration share of segments with any text flag
  pplFlaggedShare: number; // duration share of segments flagged only by perplexity
  loops: number; // segments flagged 'loop' (fixed per-segment penalty: loops are short in time but ruin the text)
  pplCeilingHit: boolean; // session median PPL above SEMANTIC.pplMedianCeiling (whole-session wrong-language / salad decode)
  perplexity?: PerplexitySummary;
  perplexityError?: string;
  segments: SemanticSegmentDetail[]; // ONLY flagged segments, rounded to 3 decimals
}

export type CorrectionStatus = 'pending' | 'accepted' | 'rejected';

/// AUG-163: one suggested meaning fix for a merged utterance; the original transcript is never changed.
export interface CorrectionItem {
  id: number; // unique within the file; one line can carry several fixes
  index: number; // utterance index = k-th timestamp line of transcript.md
  start: number; // start of the flagged whisper segment
  role: string | null;
  original: string; // the flagged segment's text, found verbatim inside the line (single-track lines merge many segments)
  suggested: string;
  status: CorrectionStatus;
}

export interface CorrectionsFile {
  version: 1;
  createdAt: string;
  model: string | null;
  items: CorrectionItem[];
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
  tokenProbs?: number[]; // AUG-163: p of each non-special token, in order
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

// AUG-165: live action items
export type ActionItemSource = 'Me' | 'Them';
export interface ActionItemLock { text?: true; owner?: true }
export interface ActionItemPraxisRef { taskId: string; projectPath: string; sentAt: string }
export interface ActionItem {
  id: string; // stable, server-assigned: `ai_` + 8 hex
  text: string; // <= 300 chars
  owner: string; // 'Me' | 'Them' | free text name ('' = unassigned); 'Me'/'Them' are shown as participant names
  source: ActionItemSource; // who said it
  createdAt: string; // ISO
  locked?: ActionItemLock; // fields edited by the user - no model operation may change/remove them
  manual?: true; // AUG-165: added by the user by hand; always fully locked
  praxis?: ActionItemPraxisRef; // AUG-166: set when the item was sent to Praxis (last send wins)
}
export interface Participants { me: string; them: string }
export interface ActionItemsFile { version: 1; participants: Participants; items: ActionItem[]; updatedAt: string }
