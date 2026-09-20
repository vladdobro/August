import type { CaptureCapabilities, SystemAudioSource } from '../types';

const API_BASE = '/api';

export interface UserPreferences {
  language?: string;
  micDeviceId?: string;
  systemAudio?: boolean;
  systemAudioSource?: SystemAudioSource;
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
  systemAudioSource: 'auto',
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

export type ResolvedSystemAudioSource = 'browser' | 'system';

/// Direct capture is usable when the probe found a method and the
/// self-test did not fail outright. 'silent' still counts as usable — the user
/// may simply have had nothing playing during the probe.
export function isSystemCaptureUsable(capabilities: CaptureCapabilities | null | undefined): boolean {
  return Boolean(capabilities?.systemCapture) && capabilities?.selfTest !== 'failed';
}

/// 'browser' always wins; 'system' and 'auto' both use the server capture
/// only when the capability probe says it is available and the self-test did
/// not fail outright, otherwise fall back to the browser picker (no loopback
/// device or helper on this machine, or a helper whose self-test failed).
export function resolveSystemAudioSource(
  source: SystemAudioSource | undefined,
  capabilities: CaptureCapabilities | null | undefined,
): ResolvedSystemAudioSource {
  const pref = source ?? DEFAULT_PREFERENCES.systemAudioSource;
  if (pref === 'browser') return 'browser';
  return isSystemCaptureUsable(capabilities) ? 'system' : 'browser';
}
