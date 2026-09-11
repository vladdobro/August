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
