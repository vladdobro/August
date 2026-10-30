import { EventEmitter } from 'node:events';

/// Shared download / move status of the opt-in local language model (AUG-162). Lives in its own module so the installer
/// and the location mover can both publish progress without importing each other.
export type LlmDownloadPhase = 'engine' | 'gpu-engine' | 'model' | 'moving';

export interface LlmDownloadStatus {
  downloading: boolean;
  phase: LlmDownloadPhase | null;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  verifying: boolean;
  error: string | null;
}

const emitter = new EventEmitter();

let status: LlmDownloadStatus = {
  downloading: false,
  phase: null,
  percent: 0,
  bytesDownloaded: 0,
  totalBytes: 0,
  verifying: false,
  error: null,
};

export function setLlmDownloadStatus(patch: Partial<LlmDownloadStatus>): void {
  status = { ...status, ...patch };
  emitter.emit('status', { ...status });
}

export function getLlmDownloadStatus(): LlmDownloadStatus { return { ...status }; }

export function onLlmDownloadStatus(listener: (s: LlmDownloadStatus) => void): () => void {
  emitter.on('status', listener);
  return () => emitter.off('status', listener);
}
