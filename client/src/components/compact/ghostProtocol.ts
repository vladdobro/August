import type { LiveLine, LiveStatus } from '../LiveTranscriptPanel';

/// BroadcastChannel shared by the main window (CompactLayer) and the ghost window (GhostApp).
/// Both load from the same origin, so no IPC is needed for lines and commands.
export const GHOST_CHANNEL = 'august-compact';

export type GhostWidget = 'ghost-caption' | 'ghost-coin';

export interface GhostState {
  widget: GhostWidget;
  phase: 'compact' | 'done';
  recording: boolean;
  live: boolean;
  // Last 3 lines only; the full list stays in the main window.
  lines: LiveLine[];
  lineCount: number;
  showCount: boolean;
  liveStatus: LiveStatus | null;
  captureLost: boolean;
  elapsedSeconds: number;
  skipStopConfirmation: boolean;
}

export type GhostCommand = 'expand' | 'pause' | 'resume' | 'end' | 'retry' | 'show-transcript';

export type GhostMessage =
  | { type: 'state'; state: GhostState }
  | { type: 'hello' }
  | { type: 'command'; command: GhostCommand };

/// Short status tag shared by every widget. Never exposes engine or audio internals.
export function statusTag(liveStatus: LiveStatus | null, live: boolean): { label: string; tone: 'ok' | 'pause' | 'error' | 'idle' } {
  if (!live || liveStatus === null) return { label: 'STOPPED', tone: 'idle' };
  switch (liveStatus) {
    case 'listening': return { label: 'LISTENING', tone: 'ok' };
    case 'connecting': return { label: 'CONNECTING', tone: 'idle' };
    case 'paused': return { label: 'PAUSED', tone: 'pause' };
    case 'interrupted': return { label: 'INTERRUPTED', tone: 'error' };
    case 'stopped': return { label: 'STOPPED', tone: 'idle' };
  }
}
