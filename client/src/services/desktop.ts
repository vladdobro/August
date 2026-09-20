/// Helpers for the Electron desktop bridge (see client/src/desktop.d.ts). Pure functions, no DOM side effects.

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock']);

const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
};

function normalizeKey(e: KeyboardEvent): string | null {
  const { key, code } = e;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  // Physical key codes keep the shortcut layout-independent (Cyrillic layouts report e.key as Cyrillic).
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (key.length === 1 && /[-=[\]\\;',./`]/.test(key)) return key;
  return null;
}

/// Builds an Electron accelerator from a keydown event. Returns null for modifier-only presses and for
/// bare keys without a modifier (a global bare key would swallow normal typing system-wide).
export function acceleratorFromKeyboardEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) return null;
  const key = normalizeKey(e);
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

/// Human-readable form of an accelerator for the Settings UI.
export function formatAccelerator(accelerator: string, platform: string): string {
  const isMac = platform === 'darwin';
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl') return isMac ? '⌘' : 'Ctrl';
      if (part === 'Alt') return isMac ? '⌥' : 'Alt';
      if (part === 'Shift') return isMac ? '⇧' : 'Shift';
      return part;
    })
    .join(isMac ? '' : ' + ');
}
