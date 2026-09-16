import type { HealthStatus, ModelSetupStatus, SessionMetadata, TranscriptionLanguage } from './types';

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

export async function fetchSessions(): Promise<SessionMetadata[]> {
  const res = await fetch(`${API_BASE}/sessions`);
  return handleJsonResponse<SessionMetadata[]>(res);
}

export async function fetchSession(id: string): Promise<SessionMetadata> {
  const res = await fetch(`${API_BASE}/sessions/${id}`);
  return handleJsonResponse<SessionMetadata>(res);
}

export async function fetchTranscript(id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions/${id}/transcript`);
  if (!res.ok) {
    if (res.status === 404) return '';
    throw new Error(`Failed to load transcript (status ${res.status})`);
  }
  return res.text();
}

export function uploadAudio(
  file: File,
  language: TranscriptionLanguage | string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<SessionMetadata> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('audio', file);
    formData.append('language', language);

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

export function uploadDualAudio(
  micFile: File,
  systemFile: File,
  language: TranscriptionLanguage | string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<SessionMetadata> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('audio', micFile);
    formData.append('systemAudio', systemFile);
    formData.append('language', language);

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

export async function sendToPraxis(sessionId: string, projectPath: string, taskName?: string): Promise<{ ok: boolean; taskId: string; taskPath: string; projectTag: string | null }> {
  const res = await fetch(`${API_BASE}/praxis/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, projectPath, ...(taskName && { taskName }) }),
  });
  return handleJsonResponse<{ ok: boolean; taskId: string; taskPath: string; projectTag: string | null }>(res);
}

export async function browsePraxisFolder(): Promise<{ path: string | null }> {
  const res = await fetch(`${API_BASE}/praxis/browse`, { method: 'POST' });
  return handleJsonResponse<{ path: string | null }>(res);
}
