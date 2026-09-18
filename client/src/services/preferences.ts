const API_BASE = '/api';

export interface UserPreferences {
  language?: string;
  micDeviceId?: string;
  systemAudio?: boolean;
  recordingMode?: 'default' | 'live';
  liveEngine?: 'local' | 'groq';
  audioBoost?: boolean;
  retranscriptionLanguage?: string | null;
  praxisProjectPath?: string | null;
  sidebarCollapsed?: boolean;
  sessionSortOrder?: 'newest' | 'oldest' | 'alphabetical';
  skipStopConfirmation?: boolean;
  skipClearConfirmation?: boolean;
}

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  language: 'auto',
  micDeviceId: 'default',
  systemAudio: false,
  recordingMode: 'default',
  liveEngine: 'local',
  audioBoost: false,
  retranscriptionLanguage: null,
  praxisProjectPath: null,
  sidebarCollapsed: false,
  sessionSortOrder: 'newest',
  skipStopConfirmation: false,
  skipClearConfirmation: false,
};

export async function getPreferences(): Promise<UserPreferences> {
  const res = await fetch(`${API_BASE}/preferences`);
  if (!res.ok) return {};
  return res.json();
}

export async function patchPreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const res = await fetch(`${API_BASE}/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Failed to save preferences');
  return res.json();
}

export async function resetPreferences(): Promise<void> {
  await fetch(`${API_BASE}/preferences`, { method: 'DELETE' });
}
