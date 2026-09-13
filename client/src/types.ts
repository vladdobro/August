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
}

export interface HealthStatus {
  status: string;
  whisperAvailable: boolean;
  modelAvailable: boolean;
  ffmpegAvailable: boolean;
  ffmpegMessage?: string | null;
  groqAvailable: boolean;
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
