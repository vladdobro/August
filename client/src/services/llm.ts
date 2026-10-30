import { LLM_PROGRESS_URL } from '../api';
import type { LlmDownloadStatus, LlmStatus } from '../types';

/// Small helpers shared by Settings and Diagnostics for the opt-in local language model (AUG-162).
export function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function formatRamGb(bytes: number): string {
  return `${Math.round(bytes / 1e9)} GB`;
}

export function qualityLabel(quality: 'basic' | 'better'): string {
  return quality === 'basic' ? 'basic' : 'higher';
}

/// Streams download progress; closes itself and calls onDone once the download ends (or the stream fails).
export function subscribeLlmProgress(onStatus: (s: LlmDownloadStatus) => void, onDone: () => void): () => void {
  const source = new EventSource(LLM_PROGRESS_URL);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    source.close();
    onDone();
  };
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as LlmDownloadStatus;
      onStatus(data);
      if (!data.downloading) finish();
    } catch {
      // ignore malformed frame
    }
  };
  source.onerror = () => finish();
  return () => {
    finished = true;
    source.close();
  };
}

export type LlmNodeState = 'off' | 'missing' | 'downloading' | 'sleeping' | 'waking' | 'loaded';

export function llmNodeState(status: LlmStatus | null): LlmNodeState {
  if (!status || !status.enabled) return 'off';
  if (status.download.downloading) return 'downloading';
  if (status.install === 'missing') return 'missing';
  if (status.runtime === 'starting') return 'waking';
  if (status.runtime === 'running') return 'loaded';
  return 'sleeping';
}
