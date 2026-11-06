import { contextBridge, ipcRenderer } from 'electron';

// Mirror of client/src/desktop.d.ts — keep the two in sync.
const api = {
  isDesktop: true as const,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('august:get-app-info'),
  getSettings: () => ipcRenderer.invoke('august:get-settings'),
  setRecordHotkey: (accelerator: string | null) => ipcRenderer.invoke('august:set-record-hotkey', accelerator),
  setMuteHotkey: (accelerator: string | null) => ipcRenderer.invoke('august:set-mute-hotkey', accelerator),
  revealSession: (sessionId: string) => ipcRenderer.invoke('august:reveal-session', sessionId),
  revealSessionsDir: () => ipcRenderer.invoke('august:reveal-sessions-dir'),
  getUpdateState: () => ipcRenderer.invoke('august:get-update-state'),
  checkForUpdates: () => {
    ipcRenderer.send('august:check-for-updates');
  },
  installUpdate: () => {
    ipcRenderer.send('august:install-update');
  },
  onUpdateState: (cb: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => cb(state);
    ipcRenderer.on('august:update-state', listener);
    return () => {
      ipcRenderer.removeListener('august:update-state', listener);
    };
  },
  setRecordingState: (recording: boolean) => {
    ipcRenderer.send('august:recording-state', recording);
  },
  onToggleRecording: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('august:toggle-recording', listener);
    return () => {
      ipcRenderer.removeListener('august:toggle-recording', listener);
    };
  },
  setMicMutedState: (muted: boolean) => {
    ipcRenderer.send('august:mic-muted-state', muted);
  },
  onToggleMute: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('august:toggle-mute', listener);
    return () => {
      ipcRenderer.removeListener('august:toggle-mute', listener);
    };
  },
  onOpenSession: (cb: (sessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => cb(sessionId);
    ipcRenderer.on('august:open-session', listener);
    return () => {
      ipcRenderer.removeListener('august:open-session', listener);
    };
  },
  setCompactMode: (request: unknown) => ipcRenderer.invoke('august:set-compact-mode', request),
  onCompactEvent: (cb: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ev: unknown) => cb(ev);
    ipcRenderer.on('august:compact-event', listener);
    return () => {
      ipcRenderer.removeListener('august:compact-event', listener);
    };
  },
  setCompactPanel: (kind: string, visible: boolean) => {
    ipcRenderer.send('august:compact-panel', { kind, visible });
  },
  onCompactPanels: (cb: (state: { copilot: boolean; assistant: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { copilot: boolean; assistant: boolean }) => cb(state);
    ipcRenderer.on('august:compact-panels', listener);
    return () => {
      ipcRenderer.removeListener('august:compact-panels', listener);
    };
  },
  reportCompactIssue: (issue: string) => {
    ipcRenderer.send('august:compact-issue', issue);
  },
  ghostSetIgnoreMouse: (ignore: boolean) => {
    ipcRenderer.send('august:ghost-ignore-mouse', ignore);
  },
  ghostResize: (size: { width: number; height: number; faceSide?: string }) => {
    ipcRenderer.send('august:ghost-resize', size);
  },
  ghostDrag: (phase: string) => {
    ipcRenderer.send('august:ghost-drag', phase);
  },
  ghostCaptionResize: (phase: string, opts?: { edge?: string; minHeight?: number }) => {
    ipcRenderer.send('august:ghost-caption-resize', opts ? { phase, ...opts } : phase);
  },
  resetGhostPosition: () => ipcRenderer.invoke('august:reset-ghost-position'),
  writeClipboard: (text: string) => ipcRenderer.invoke('august:write-clipboard', text),
};

contextBridge.exposeInMainWorld('august', api);
