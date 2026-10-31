import type { ActionItemsFile, CaptureCapabilities, CorrectionStatus, CorrectionsFile, HealthStatus, LlmModelId, LlmModelInfo, LlmStatus, GroqTextStatus, ModelSetupStatus, ServerCapture, SessionMetadata, StorageSummary, TranscriptionLanguage } from './types';

export interface UploadProgress {
  loaded: number;
  total: number;
}

const API_BASE = '/api';

async function handleJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore body parse failure, use default message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function switchEngine(engine: 'cpu' | 'cuda'): Promise<{ ok: boolean; engine: string; cudaStatus: string }> {
  const res = await fetch(`${API_BASE}/engine/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine }),
  });
  return handleJsonResponse<{ ok: boolean; engine: string; cudaStatus: string }>(res);
}

export const CUDA_PROGRESS_URL = `${API_BASE}/engine/cuda-progress`;

export async function fetchLlmModels(): Promise<LlmModelInfo[]> {
  const res = await fetch(`${API_BASE}/llm/models`);
  return handleJsonResponse<LlmModelInfo[]>(res);
}

export async function fetchLlmStatus(): Promise<LlmStatus> {
  const res = await fetch(`${API_BASE}/llm/status`);
  return handleJsonResponse<LlmStatus>(res);
}

export async function enableLlm(modelId: LlmModelId): Promise<LlmStatus> {
  const res = await fetch(`${API_BASE}/llm/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId }),
  });
  return handleJsonResponse<LlmStatus>(res);
}

export async function disableLlm(): Promise<LlmStatus> {
  const res = await fetch(`${API_BASE}/llm/disable`, { method: 'POST' });
  return handleJsonResponse<LlmStatus>(res);
}

export async function retryLlmDownload(): Promise<LlmStatus> {
  const res = await fetch(`${API_BASE}/llm/download`, { method: 'POST' });
  return handleJsonResponse<LlmStatus>(res);
}

export async function fetchGroqTextStatus(): Promise<GroqTextStatus> {
  const res = await fetch(`${API_BASE}/groq-text/status`);
  return handleJsonResponse<GroqTextStatus>(res);
}

export async function enableGroqText(): Promise<GroqTextStatus> {
  const res = await fetch(`${API_BASE}/groq-text/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accept: true }),
  });
  return handleJsonResponse<GroqTextStatus>(res);
}

export async function disableGroqText(): Promise<GroqTextStatus> {
  const res = await fetch(`${API_BASE}/groq-text/disable`, { method: 'POST' });
  return handleJsonResponse<GroqTextStatus>(res);
}

export async function browseLlmFolder(): Promise<{ path: string | null }> {
  const res = await fetch(`${API_BASE}/llm/browse-folder`, { method: 'POST' });
  return handleJsonResponse<{ path: string | null }>(res);
}

/// Moves the model files to <path>/August LLM; null = back to the default folder.
export async function setLlmLocation(path: string | null): Promise<LlmStatus> {
  const res = await fetch(`${API_BASE}/llm/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return handleJsonResponse<LlmStatus>(res);
}

export async function testLlm(): Promise<{ ok: boolean; reply: string; latencyMs: number; totalMs: number }> {
  const res = await fetch(`${API_BASE}/llm/test`, { method: 'POST' });
  return handleJsonResponse<{ ok: boolean; reply: string; latencyMs: number; totalMs: number }>(res);
}

export const LLM_PROGRESS_URL = `${API_BASE}/llm/progress`;

export async function fetchSessions(): Promise<SessionMetadata[]> {
  const res = await fetch(`${API_BASE}/sessions`);
  return handleJsonResponse<SessionMetadata[]>(res);
}

export async function fetchSession(id: string): Promise<SessionMetadata> {
  const res = await fetch(`${API_BASE}/sessions/${id}`);
  return handleJsonResponse<SessionMetadata>(res);
}

/// AUG-163: suggested meaning fixes; a session without any returns an empty list.
export async function fetchCorrections(id: string): Promise<CorrectionsFile> {
  const res = await fetch(`${API_BASE}/sessions/${id}/corrections`);
  if (res.status === 404) return { version: 1, createdAt: '', model: null, items: [] };
  return handleJsonResponse<CorrectionsFile>(res);
}

/// AUG-165: action items collected during a live recording; null when the session has none.
export async function fetchActionItems(id: string): Promise<ActionItemsFile | null> {
  const res = await fetch(`${API_BASE}/sessions/${id}/action-items`);
  if (res.status === 404) return null;
  return handleJsonResponse<ActionItemsFile>(res);
}

export async function updateActionItem(id: string, itemId: string, patch: { text?: string; owner?: string }): Promise<ActionItemsFile> {
  const res = await fetch(`${API_BASE}/sessions/${id}/action-items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return handleJsonResponse<ActionItemsFile>(res);
}

/// AUG-165: hand-written item (fully locked); creates action-items.json when the session has none.
export async function addActionItem(id: string, item: { text: string; owner?: string }): Promise<ActionItemsFile> {
  const res = await fetch(`${API_BASE}/sessions/${id}/action-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  return handleJsonResponse<ActionItemsFile>(res);
}

export async function deleteActionItem(id: string, itemId: string): Promise<ActionItemsFile> {
  const res = await fetch(`${API_BASE}/sessions/${id}/action-items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  return handleJsonResponse<ActionItemsFile>(res);
}

export async function setCorrectionStatus(id: string, itemId: number, status: CorrectionStatus): Promise<CorrectionsFile> {
  const res = await fetch(`${API_BASE}/sessions/${id}/corrections/${itemId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return handleJsonResponse<CorrectionsFile>(res);
}

export async function setAllCorrectionsStatus(id: string, status: 'accepted' | 'rejected'): Promise<CorrectionsFile> {
  const res = await fetch(`${API_BASE}/sessions/${id}/corrections/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  return handleJsonResponse<CorrectionsFile>(res);
}

export async function fetchCorrectedTranscript(id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions/${id}/transcript/corrected`);
  if (!res.ok) throw new Error(`Failed to load corrected transcript (status ${res.status})`);
  return res.text();
}

export async function fetchTranscript(id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions/${id}/transcript`);
  if (!res.ok) {
    if (res.status === 404) return '';
    throw new Error(`Failed to load transcript (status ${res.status})`);
  }
  return res.text();
}

function postSessionUpload(formData: FormData, onProgress?: (progress: UploadProgress) => void): Promise<SessionMetadata> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/sessions/upload`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({ loaded: e.loaded, total: e.total });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as SessionMetadata);
        } catch {
          reject(new Error('Invalid response from server'));
        }
      } else {
        let message = `Request failed with status ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.error) message = body.error;
        } catch {
          // use default message
        }
        reject(new Error(message));
      }
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(formData);
  });
}

export function uploadAudio(
  file: File,
  language: TranscriptionLanguage | string,
  onProgress?: (progress: UploadProgress) => void,
  liveKey?: string | null,
): Promise<SessionMetadata> {
  const formData = new FormData();
  formData.append('audio', file);
  formData.append('language', language);
  if (liveKey) formData.append('liveKey', liveKey);
  return postSessionUpload(formData, onProgress);
}

export function uploadDualAudio(
  micFile: File,
  systemFile: File,
  language: TranscriptionLanguage | string,
  onProgress?: (progress: UploadProgress) => void,
  liveKey?: string | null,
): Promise<SessionMetadata> {
  const formData = new FormData();
  formData.append('audio', micFile);
  formData.append('systemAudio', systemFile);
  formData.append('language', language);
  if (liveKey) formData.append('liveKey', liveKey);
  return postSessionUpload(formData, onProgress);
}

/// Dual-track upload where the system track was captured server-side
/// (AUG-105): the server attaches the capture file by captureId and uses
/// micStartedAt (wall-clock ms) to offset-align the two tracks.
export function uploadDualAudioWithCapture(
  micFile: File,
  captureId: string,
  micStartedAt: number,
  language: TranscriptionLanguage | string,
  onProgress?: (progress: UploadProgress) => void,
  liveKey?: string | null,
): Promise<SessionMetadata> {
  const formData = new FormData();
  formData.append('audio', micFile);
  formData.append('captureId', captureId);
  formData.append('micStartedAt', String(micStartedAt));
  formData.append('language', language);
  if (liveKey) formData.append('liveKey', liveKey);
  return postSessionUpload(formData, onProgress);
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to delete session (status ${res.status})`);
  }
}

export async function renameSession(id: string, title: string): Promise<SessionMetadata> {
  const res = await fetch(`${API_BASE}/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return handleJsonResponse<SessionMetadata>(res);
}

export async function retranscribeSession(id: string, language?: string, boost?: boolean): Promise<SessionMetadata> {
  const res = await fetch(`${API_BASE}/sessions/${id}/retranscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, boost }),
  });
  return handleJsonResponse<SessionMetadata>(res);
}

export async function cancelTranscription(id: string): Promise<SessionMetadata> {
  const res = await fetch(`${API_BASE}/sessions/${id}/cancel`, { method: 'POST' });
  return handleJsonResponse<SessionMetadata>(res);
}

export async function fetchStorage(): Promise<StorageSummary> {
  const res = await fetch(`${API_BASE}/sessions/storage`);
  return handleJsonResponse<StorageSummary>(res);
}

export async function deleteSessionAudio(id: string, file?: string): Promise<{ session: SessionMetadata; freedBytes: number }> {
  const res = await fetch(`${API_BASE}/sessions/${id}/audio${file ? `?file=${encodeURIComponent(file)}` : ''}`, { method: 'DELETE' });
  return handleJsonResponse<{ session: SessionMetadata; freedBytes: number }>(res);
}

export async function redownloadSessionAudio(id: string): Promise<SessionMetadata> {
  const res = await fetch(`${API_BASE}/sessions/${id}/redownload`, { method: 'POST' });
  return handleJsonResponse<SessionMetadata>(res);
}

export async function transcribeFromUrl(url: string, language: TranscriptionLanguage | string): Promise<SessionMetadata> {
  const res = await fetch(`${API_BASE}/sessions/from-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, language }),
  });
  return handleJsonResponse<SessionMetadata>(res);
}

export async function checkHealth(): Promise<HealthStatus> {
  const res = await fetch(`${API_BASE}/health`);
  return handleJsonResponse<HealthStatus>(res);
}

export async function saveGroqKey(key: string): Promise<{ ok: boolean; groqAvailable: boolean }> {
  const res = await fetch(`${API_BASE}/config/groq-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return handleJsonResponse<{ ok: boolean; groqAvailable: boolean }>(res);
}

export async function fetchSetupStatus(): Promise<ModelSetupStatus> {
  const res = await fetch(`${API_BASE}/setup/status`);
  return handleJsonResponse<ModelSetupStatus>(res);
}

export const SETUP_PROGRESS_URL = `${API_BASE}/setup/download-progress`;

export async function validatePraxisProject(projectPath: string): Promise<{ valid: boolean; projectPath: string }> {
  const res = await fetch(`${API_BASE}/praxis/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath }),
  });
  return handleJsonResponse<{ valid: boolean; projectPath: string }>(res);
}

export async function sendToPraxis(sessionId: string, projectPath: string, taskName?: string): Promise<{ ok: boolean; taskId: string; taskPath: string; projectTag: string | null; promptSource?: 'project' | 'default' | 'built-in' }> {
  const res = await fetch(`${API_BASE}/praxis/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, projectPath, ...(taskName && { taskName }) }),
  });
  return handleJsonResponse<{ ok: boolean; taskId: string; taskPath: string; projectTag: string | null; promptSource?: 'project' | 'default' | 'built-in' }>(res);
}

export async function fetchPraxisDefaultPrompt(): Promise<{ prompt: string; variables: string[] }> {
  const res = await fetch(`${API_BASE}/praxis/default-prompt`);
  if (!res.ok) throw new Error('Failed to load default prompt');
  return res.json();
}

export async function browsePraxisFolder(): Promise<{ path: string | null }> {
  const res = await fetch(`${API_BASE}/praxis/browse`, { method: 'POST' });
  return handleJsonResponse<{ path: string | null }>(res);
}

/// refresh=true makes the server re-run the probe and self-test instead of answering from its 30 s cache.
export async function fetchCaptureCapabilities(refresh = false): Promise<CaptureCapabilities> {
  const res = await fetch(`${API_BASE}/capture/capabilities${refresh ? '?refresh=1' : ''}`);
  return handleJsonResponse<CaptureCapabilities>(res);
}

/// AUG-113: live=true makes the server tee its capture into the live-transcription
/// pipeline; the returned captureId is then passed to LiveTranscriptionClient.start().
export async function startServerCapture(opts: { live?: boolean } = {}): Promise<ServerCapture> {
  const res = await fetch(`${API_BASE}/capture/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ live: opts.live === true }),
  });
  return handleJsonResponse<ServerCapture>(res);
}

export async function stopServerCapture(captureId: string): Promise<ServerCapture & { path: string; durationMs: number }> {
  const res = await fetch(`${API_BASE}/capture/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captureId }),
  });
  return handleJsonResponse<ServerCapture & { path: string; durationMs: number }>(res);
}
