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

export interface AugustDesktopApi {
  isDesktop: true;
  platform: string;
  getAppInfo(): Promise<DesktopAppInfo>;
  getSettings(): Promise<DesktopSettings>;
  setRecordHotkey(accelerator: string | null): Promise<DesktopHotkeyResult>;
  setRecordingState(recording: boolean): void;
  onToggleRecording(cb: () => void): () => void;
  onOpenSession(cb: (sessionId: string) => void): () => void;
}

declare global {
  interface Window {
    august?: AugustDesktopApi;
  }
}
