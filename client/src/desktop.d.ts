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
}

declare global {
  interface Window {
    august?: AugustDesktopApi;
  }
}
