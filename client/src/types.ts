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
