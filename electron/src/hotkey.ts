import { globalShortcut } from 'electron';

export interface HotkeyResult {
  ok: boolean;
  error?: string;
}

/// Replaces the single global record hotkey. null unregisters everything (hotkey disabled).
export function applyRecordHotkey(accelerator: string | null, onTrigger: () => void): HotkeyResult {
  globalShortcut.unregisterAll();
  if (!accelerator) return { ok: true };
  try {
    const registered = globalShortcut.register(accelerator, onTrigger);
    return registered
      ? { ok: true }
      : { ok: false, error: `"${accelerator}" is already in use by another application.` };
  } catch (err) {
    return { ok: false, error: (err as Error).message || `Invalid shortcut "${accelerator}".` };
  }
}
