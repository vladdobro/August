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
  systemOffsetMs?: number;
}

export interface HealthStatus {
  status: string;
  whisperAvailable: boolean;
  modelAvailable: boolean;
  ffmpegAvailable: boolean;
  ffmpegMessage?: string | null;
  groqAvailable: boolean;
  // 'cpu' when whisper runs without the GPU (platform default, WHISPER_USE_GPU=0, or runtime fallback — AUG-116).
  gpuBackend?: 'vulkan' | 'metal' | 'cpu' | 'unknown';
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
