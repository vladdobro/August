import type { AiModel, CaptureCapabilities, SystemAudioSource } from '../types';

const API_BASE = '/api';

export interface PraxisProject {
  path: string;
  name: string;
  isDefault: boolean;
  prompt?: string;
}

export type CompactModePreference = 'follow' | 'indicator' | 'transcript';
export type CompactIndicatorWidget = 'dock-square' | 'ghost-coin';
export type CompactTranscriptWidget = 'dock-strip' | 'ghost-caption';

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
  praxisProjects?: PraxisProject[];
  praxisDefaultPrompt?: string | null;
  // AUG-192: recently sent unregistered Praxis folders, newest first, max 5 (server-sanitized). Not localStorage: the packaged origin port changes every launch.
  praxisRecentPaths?: string[];
  sidebarCollapsed?: boolean;
  sessionSortOrder?: 'newest' | 'oldest' | 'alphabetical';
  skipClearConfirmation?: boolean;
  gpuEngine?: 'cpu' | 'cuda';
  autoDeleteWav?: boolean;
  autoDeleteWavThreshold?: number;
  // AUG-163: let the local model suggest meaning fixes for suspicious lines (accepted one by one in the transcript view)
  llmCorrections?: boolean;
  // AUG-164: who fixes flagged lines when both the local model and Online text correction (Groq) are on
  batchCorrectionEngine?: 'local' | 'groq';
  // AUG-190: children of Online text (Groq); default on, only used while its consent is active
  groqLiveCorrection?: boolean;
  groqLiveActionItems?: boolean;
  // Compact Mode (AUG-156)
  compactEnabled?: boolean;
  compactMode?: CompactModePreference;
  compactIndicatorWidget?: CompactIndicatorWidget;
  compactTranscriptWidget?: CompactTranscriptWidget;
  compactAlwaysOnTop?: boolean;
  compactExpandOn?: 'stop' | 'click';
  compactStripWidth?: number;
  // Ghost Caption height in px (72–480), set by dragging the caption's inner edge.
  compactCaptionHeight?: number;
  // Ghost Caption width in px (320–760), set by dragging the caption's left/right edge (AUG-187).
  compactCaptionWidth?: number;
  // AUG-188: Ghost Caption text size in px, one of 12/14/16/18/22.
  compactCaptionFontSize?: number;
  // AUG-188: Ghost Caption background opacity in %, one of 40/60/78/90/100 (text stays opaque).
  compactCaptionOpacity?: number;
  // One-time "snap your call" hint. Stored here, not localStorage: the packaged app's origin port changes every launch.
  compactHintSeen?: boolean;
  // AUG-198: AI assistants tab. Mode / enabled / consents are server-written (GET /api/assistant/status), never patched.
  aiCopilotModel?: AiModel;
  aiCopilotAlwaysBudgetUsd?: number;
  aiModel?: AiModel;
  aiSessionBudgetUsd?: number;
  aiTranscriptWindowMin?: 2 | 5 | 10 | 15;
}

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  language: 'auto',
  micDeviceId: 'default',
  // On by default: dual-track (mic + system) is the app's primary recording
  // shape, and FileUpload's initial toggle state derives from this value.
  systemAudio: true,
  systemAudioSource: 'auto',
  recordingMode: 'default',
  liveEngine: 'local',
  audioBoost: false,
  retranscriptionLanguage: null,
  praxisProjectPath: null,
  praxisProjects: [],
  praxisDefaultPrompt: null,
  praxisRecentPaths: [],
  sidebarCollapsed: false,
  sessionSortOrder: 'newest',
  skipClearConfirmation: false,
  gpuEngine: 'cpu',
  autoDeleteWav: false,
  autoDeleteWavThreshold: 70,
  llmCorrections: false,
  batchCorrectionEngine: 'local',
  groqLiveCorrection: true,
  groqLiveActionItems: true,
  compactEnabled: true,
  compactMode: 'follow',
  compactIndicatorWidget: 'dock-square',
  compactTranscriptWidget: 'dock-strip',
  compactAlwaysOnTop: true,
  compactExpandOn: 'stop',
  compactStripWidth: 360,
  compactCaptionHeight: 112,
  compactCaptionWidth: 760,
  compactCaptionFontSize: 14,
  compactCaptionOpacity: 78,
  compactHintSeen: false,
  aiCopilotModel: 'sonnet',
  aiCopilotAlwaysBudgetUsd: 2,
  aiModel: 'sonnet',
  aiSessionBudgetUsd: 2,
  aiTranscriptWindowMin: 5,
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
