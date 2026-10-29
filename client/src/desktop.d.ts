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
export interface DesktopCompactRequest { shape: DesktopCompactShape; stripWidth?: number; alwaysOnTop?: boolean; }
export interface DesktopCompactResult { ok: boolean; shape: DesktopCompactShape; error?: string; }
export type DesktopCompactEvent = { type: 'expand' } | { type: 'toggle' } | { type: 'strip-width'; width: number };
export type DesktopCompactIssue = 'interrupted' | 'capture-lost';
export type DesktopGhostDragPhase = 'start' | 'move' | 'end';

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
  onOpenSession(cb: (sessionId: string) => void): () => void;
  // Compact Mode (AUG-156). Main window: resize to a dock shape or hide behind a ghost window; 'none' restores the saved bounds.
  setCompactMode?(request: DesktopCompactRequest): Promise<DesktopCompactResult>;
  onCompactEvent?(cb: (event: DesktopCompactEvent) => void): () => void;
  // Native notification, shown by main only while the main window is hidden.
  reportCompactIssue?(issue: DesktopCompactIssue): void;
  // Ghost window only: click-through toggle (caption), size (coin hover), drag driven by the cursor position in main.
  ghostSetIgnoreMouse?(ignore: boolean): void;
  ghostResize?(size: { width: number; height: number }): void;
  ghostDrag?(phase: DesktopGhostDragPhase): void;
}

declare global {
  interface Window {
    august?: AugustDesktopApi;
  }
}
