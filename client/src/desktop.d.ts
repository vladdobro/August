/// Bridge exposed by electron/src/preload.cts via contextBridge as `window.august`.
/// Absent in the plain browser build — every call site must guard on `window.august`.
export interface DesktopAppInfo {
  version: string;
  platform: string;
  packaged: boolean;
}

export interface DesktopSettings {
  // Electron accelerator string (e.g. "CommandOrControl+Alt+R"); null = global hotkey disabled.
  recordHotkey: string | null;
  defaultRecordHotkey: string;
  hotkeyRegistered: boolean;
  muteHotkey?: string | null;
  defaultMuteHotkey?: string;
  muteHotkeyRegistered?: boolean;
}

export interface DesktopMuteHotkeyResult {
  ok: boolean;
  muteHotkey: string | null;
  error?: string;
}

export interface DesktopHotkeyResult {
  ok: boolean;
  recordHotkey: string | null;
  error?: string;
}

export interface DesktopRevealResult {
  ok: boolean;
  error?: string;
}

export type DesktopCompactShape = 'none' | 'strip' | 'square' | 'caption' | 'coin';
export interface DesktopCompactRequest { shape: DesktopCompactShape; stripWidth?: number; captionHeight?: number; captionWidth?: number; alwaysOnTop?: boolean; }
export interface DesktopCompactResult { ok: boolean; shape: DesktopCompactShape; error?: string; }
export type DesktopCompactEvent =
  | { type: 'expand' }
  | { type: 'toggle' }
  | { type: 'strip-width'; width: number }
  | { type: 'caption-height'; height: number }
  | { type: 'caption-width'; width: number };
export type DesktopCompactIssue = 'interrupted' | 'capture-lost';

// Mirror of UpdateState in electron/src/updater.ts (the state machine lives only in main). 'error' renders like 'idle'.
export type DesktopUpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };
export type DesktopGhostDragPhase = 'start' | 'move' | 'end';
export type DesktopGhostResizeEdge = 'height' | 'left' | 'right';

export interface AugustDesktopApi {
  isDesktop: true;
  platform: string;
  getAppInfo(): Promise<DesktopAppInfo>;
  getSettings(): Promise<DesktopSettings>;
  setRecordHotkey(accelerator: string | null): Promise<DesktopHotkeyResult>;
  // Reveals the session's folder in Finder/Explorer; the main process resolves the path from the id.
  revealSession(sessionId: string): Promise<DesktopRevealResult>;
  // Opens the whole sessions folder (Archive page); optional because older desktop shells lack it.
  revealSessionsDir?(): Promise<DesktopRevealResult>;
  setRecordingState(recording: boolean): void;
  onToggleRecording(cb: () => void): () => void;
  // AUG-181: mic mute. onToggleMute fires on the global mute hotkey / tray item, only while recording.
  setMuteHotkey?(accelerator: string | null): Promise<DesktopMuteHotkeyResult>;
  setMicMutedState?(muted: boolean): void;
  onToggleMute?(cb: () => void): () => void;
  onOpenSession(cb: (sessionId: string) => void): () => void;
  // Compact Mode (AUG-156). Main window: resize to a dock shape or hide behind a ghost window; 'none' restores the saved bounds.
  setCompactMode?(request: DesktopCompactRequest): Promise<DesktopCompactResult>;
  onCompactEvent?(cb: (event: DesktopCompactEvent) => void): () => void;
  // Auto-update (AUG-157). getUpdateState resolves null when the shell has no updater (unpackaged build).
  getUpdateState?(): Promise<DesktopUpdateState | null>;
  checkForUpdates?(): void;
  installUpdate?(): void;
  onUpdateState?(cb: (state: DesktopUpdateState) => void): () => void;
  // Native notification, shown by main only while the main window is hidden.
  reportCompactIssue?(issue: DesktopCompactIssue): void;
  // Ghost window only: click-through toggle (caption), size (coin hover), drag driven by the cursor position in main.
  ghostSetIgnoreMouse?(ignore: boolean): void;
  ghostResize?(size: { width: number; height: number; faceSide?: 'left' | 'right' }): void;
  ghostDrag?(phase: DesktopGhostDragPhase): void;
  // Ghost Caption only: height drag from the inner edge or width drag from the left / right edge (edge, default 'height');
  // main sends the final size back as a caption-height / caption-width event. minHeight raises the height floor (AUG-187).
  ghostCaptionResize?(phase: DesktopGhostDragPhase, opts?: { edge?: DesktopGhostResizeEdge; minHeight?: number }): void;
  // Main window only: clears the saved Ghost Mode position so the caption and coin return to their default spots (AUG-187).
  resetGhostPosition?(): Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    august?: AugustDesktopApi;
  }
}
