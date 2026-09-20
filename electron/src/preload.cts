import { contextBridge, ipcRenderer } from 'electron';

// Mirror of client/src/desktop.d.ts — keep the two in sync.
const api = {
  isDesktop: true as const,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('august:get-app-info'),
  getSettings: () => ipcRenderer.invoke('august:get-settings'),
  setRecordHotkey: (accelerator: string | null) => ipcRenderer.invoke('august:set-record-hotkey', accelerator),
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
  onOpenSession: (cb: (sessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => cb(sessionId);
    ipcRenderer.on('august:open-session', listener);
    return () => {
      ipcRenderer.removeListener('august:open-session', listener);
    };
  },
};

contextBridge.exposeInMainWorld('august', api);
