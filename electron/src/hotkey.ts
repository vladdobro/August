import { globalShortcut } from 'electron';

export interface HotkeyResult {
  ok: boolean;
  error?: string;
}

export type HotkeySlot = 'record' | 'mute';

/// Accelerator currently registered per slot. Slots never touch each other's shortcuts (no unregisterAll).
const registered = new Map<HotkeySlot, string>();
const SLOT_LABEL: Record<HotkeySlot, string> = { record: 'the Record hotkey', mute: 'the Mute hotkey' };

/// Replaces the global hotkey of one slot. null unregisters only that slot (hotkey disabled).
export function applyHotkey(slot: HotkeySlot, accelerator: string | null, onTrigger: () => void): HotkeyResult {
  const previous = registered.get(slot);
  if (previous) {
    globalShortcut.unregister(previous);
    registered.delete(slot);
  }
  if (!accelerator) return { ok: true };

  for (const [other, held] of registered) {
    if (other !== slot && held.toLowerCase() === accelerator.toLowerCase()) {
      return { ok: false, error: `"${accelerator}" is already in use by ${SLOT_LABEL[other]}.` };
    }
  }

  try {
    const ok = globalShortcut.register(accelerator, onTrigger);
    if (!ok) return { ok: false, error: `"${accelerator}" is already in use by another application.` };
    registered.set(slot, accelerator);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || `Invalid shortcut "${accelerator}".` };
  }
}

export function applyRecordHotkey(accelerator: string | null, onTrigger: () => void): HotkeyResult {
  return applyHotkey('record', accelerator, onTrigger);
}

export function applyMuteHotkey(accelerator: string | null, onTrigger: () => void): HotkeyResult {
  return applyHotkey('mute', accelerator, onTrigger);
}
