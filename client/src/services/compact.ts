import { DEFAULT_PREFERENCES, type UserPreferences } from './preferences';
import type { DesktopCompactShape } from '../desktop';

export type CompactKind = 'indicator' | 'transcript';
export type CompactWidget = 'dock-strip' | 'dock-square' | 'ghost-caption' | 'ghost-coin';

export function compactPrefs(p: UserPreferences) {
  return {
    enabled: p.compactEnabled ?? DEFAULT_PREFERENCES.compactEnabled,
    mode: p.compactMode ?? DEFAULT_PREFERENCES.compactMode,
    indicatorWidget: p.compactIndicatorWidget ?? DEFAULT_PREFERENCES.compactIndicatorWidget,
    transcriptWidget: p.compactTranscriptWidget ?? DEFAULT_PREFERENCES.compactTranscriptWidget,
    alwaysOnTop: p.compactAlwaysOnTop ?? DEFAULT_PREFERENCES.compactAlwaysOnTop,
    expandOn: p.compactExpandOn ?? DEFAULT_PREFERENCES.compactExpandOn,
    stripWidth: p.compactStripWidth ?? DEFAULT_PREFERENCES.compactStripWidth,
    captionHeight: p.compactCaptionHeight ?? DEFAULT_PREFERENCES.compactCaptionHeight,
    hintSeen: p.compactHintSeen ?? DEFAULT_PREFERENCES.compactHintSeen,
  };
}

/// enabled ? (mode === 'follow' ? (live ? transcript : indicator) : mode) — a 'transcript' recording whose Live was
/// stopped falls back to the indicator (no lines to show).
export function resolveCompactKind(p: UserPreferences, liveActive: boolean): CompactKind | null {
  const c = compactPrefs(p);
  if (!c.enabled) return null;
  if (c.mode === 'indicator') return 'indicator';
  return liveActive ? 'transcript' : 'indicator';
}

export function resolveCompactWidget(p: UserPreferences, kind: CompactKind): CompactWidget {
  const c = compactPrefs(p);
  return kind === 'transcript' ? c.transcriptWidget : c.indicatorWidget;
}

export function shapeForWidget(w: CompactWidget): DesktopCompactShape {
  switch (w) {
    case 'dock-strip': return 'strip';
    case 'dock-square': return 'square';
    case 'ghost-caption': return 'caption';
    case 'ghost-coin': return 'coin';
  }
}

export function isDockWidget(w: CompactWidget | null): boolean {
  return w === 'dock-strip' || w === 'dock-square';
}

/// "Always live transcript" turns Live on for a Default recording (desktop only); the saved recordingMode is untouched.
export function shouldAutoEnableLive(p: UserPreferences, isDesktop: boolean): boolean {
  const c = compactPrefs(p);
  return isDesktop && c.enabled && c.mode === 'transcript';
}

export function formatClock(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
