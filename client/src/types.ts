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
  systemOffsetMs?: number;
  // Dual-track only (AUG-125): ffprobe length of each 16 kHz WAV in seconds.
  trackDurations?: { mic: number; system: number };
  // Dual-track only (AUG-125): non-blocking notice when one track is much shorter than the other.
  trackWarning?: string;
  sourceUrl?: string;
  downloadProgress?: number;
  // AUG-150: set when every audio file was removed from the Archive page; transcript and metadata remain.
  audioDeletedAt?: string;
  audioDeletedFiles?: Array<{ name: string; bytes: number; auto?: boolean }>;
  confidenceScore?: number; // AUG-152: 0–100 transcription confidence
  wavAutoDeletedAt?: string; // AUG-152: converted WAV removed automatically; source audio kept
  participants?: { me: string; them: string }; // AUG-165: names for Me / Them entered at live recording start
}

export type SessionSource = 'recording' | 'upload' | 'link' | 'platform';
export type StorageFileKind = 'audio' | 'transcript' | 'meta' | 'other';
export interface SessionStorageFile { name: string; bytes: number; kind: StorageFileKind; note?: 'original' | 'converted' | 'boosted'; deleted?: boolean; auto?: boolean; }
export interface SessionStorageEntry { id: string; title: string; createdAt: string; status: SessionStatus; source: SessionSource; sourceUrl?: string; error?: string; totalBytes: number; audioBytes: number; audioDeleted: boolean; wavAutoDeleted: boolean; files: SessionStorageFile[]; }
export interface StorageSummary { sessionsDir: string; totalBytes: number; sessions: SessionStorageEntry[]; }

export interface HealthStatus {
  status: string;
  whisperAvailable: boolean;
  modelAvailable: boolean;
  modelPath?: string;
  modelError?: string | null;
  ffmpegAvailable: boolean;
  ffmpegMessage?: string | null;
  groqAvailable: boolean;
  // 'cpu' when whisper runs without the GPU (platform default, WHISPER_USE_GPU=0, or runtime fallback — AUG-116).
  gpuBackend?: 'vulkan' | 'metal' | 'cuda' | 'cpu' | 'unknown';
  gpuEngine?: 'cpu' | 'cuda';
  gpuEnginePinned?: boolean;
  nvidiaGpu?: { detected: boolean; gpuName: string | null };
  cudaStatus?: 'present' | 'downloading' | 'missing' | 'not-needed';
}

export type ModelState = 'present' | 'downloading' | 'missing';

export interface ModelSetupStatus {
  state: ModelState;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  verifying: boolean;
  error: string | null;
}

export type SystemAudioSource = 'auto' | 'browser' | 'system';

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

export interface ServerCapture {
  captureId: string;
  // First-written-byte time of the server capture (ms epoch); falls back to spawnedAt when startedAtSource is 'spawn'.
  startedAt: number;
  spawnedAt: number;
  startedAtSource: 'first-byte' | 'spawn';
  // AUG-113: true when the server also tees PCM to the live-transcription WebSocket.
  live?: boolean;
}

// Opt-in local language model (AUG-162).
export type LlmModelId = 'qwen2.5-1.5b-instruct-q4km' | 'qwen2.5-3b-instruct-q4km';

export interface LlmModelInfo {
  id: LlmModelId;
  label: string;
  quality: 'basic' | 'better';
  diskBytes: number;
  ramBytes: number;
}

export interface LlmDownloadStatus {
  downloading: boolean;
  phase: 'engine' | 'gpu-engine' | 'model' | 'moving' | null;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  verifying: boolean;
  error: string | null;
}

export interface LlmLocation {
  root: string;
  isDefault: boolean;
  pinned: boolean;
  available: boolean;
  freeBytes: number | null;
}

export interface GroqTextStatus {
  enabled: boolean;
  consentAt: string | null;
  consentStale: boolean;
  groqAvailable: boolean;
  model: string;
  /// AUG-164: Groq keeps refusing requests from this network (region block); corrections are skipped meanwhile.
  blocked: boolean;
}

export interface LlmStatus {
  enabled: boolean;
  modelId: LlmModelId;
  supported: boolean;
  install: 'missing' | 'ready';
  runtime: 'stopped' | 'starting' | 'running';
  download: LlmDownloadStatus;
  location: LlmLocation;
}

/// AUG-163: suggested meaning fixes for a transcript (server: transcript.corrected.json). The original is never changed.
export type CorrectionStatus = 'pending' | 'accepted' | 'rejected';

export interface CorrectionItem {
  id: number; // unique within the file; one line can carry several fixes
  index: number; // utterance index = k-th timestamp line of the transcript
  start: number;
  role: string | null;
  original: string; // flagged segment text, found verbatim inside the line
  suggested: string;
  status: CorrectionStatus;
}

export interface CorrectionsFile {
  version: 1;
  createdAt: string;
  model: string | null;
  items: CorrectionItem[];
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
