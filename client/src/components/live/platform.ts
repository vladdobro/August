// AUG-199: platform check for the live column shortcuts (Cmd on macOS, Ctrl elsewhere). Display only; guards are by modifier.
export function isMacPlatform(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.august?.platform) return window.august.platform === 'darwin';
  return /mac/i.test(navigator.platform || '');
}

export function shortcutLabel(digit: string): string {
  return isMacPlatform() ? `⌘${digit}` : `Ctrl+${digit}`;
}
