import type { ActionItem, Participants } from '../types';
import type { LiveLine, LiveStatus } from '../components/LiveTranscriptPanel';

export interface CompactSnapshot {
  recording: boolean;
  live: boolean;
  lines: LiveLine[];
  liveStatus: LiveStatus | null;
  liveError: string | null;
  captureLost: boolean;
  elapsedSeconds: number;
  levels: number[];
  dualTrack: boolean;
  skipStopConfirmation: boolean;
  actionItems: ActionItem[]; // AUG-165
  participants: Participants;
  actionEnabled: boolean | null;
}

export interface CompactActions {
  end(): void;
  pauseLive(): void;
  resumeLive(): void;
  stopLive(): void;
  retryLive(): void;
  copyAll(): void;
  showLivePanel(): void;
  addActionItem(text: string, owner: string): void;
  editActionItem(id: string, patch: { text?: string; owner?: string }): void;
  deleteActionItem(id: string): void;
}

export interface CompactController {
  enter(): void;
  expand(): void;
}

// Tiny external store so App does not re-render on every audio frame (consumed via useSyncExternalStore).
let snapshot: CompactSnapshot = {
  recording: false,
  live: false,
  lines: [],
  liveStatus: null,
  liveError: null,
  captureLost: false,
  elapsedSeconds: 0,
  levels: new Array(12).fill(0),
  dualTrack: false,
  skipStopConfirmation: false,
  actionItems: [],
  participants: { me: '', them: '' },
  actionEnabled: null,
};
const listeners = new Set<() => void>();
let currentActions: CompactActions | null = null;
let controller: CompactController | null = null;

export const compactStore = {
  getSnapshot(): CompactSnapshot {
    return snapshot;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  publish(next: CompactSnapshot): void {
    snapshot = next;
    listeners.forEach((l) => l());
  },
  setActions(a: CompactActions | null): void {
    currentActions = a;
  },
  actions(): CompactActions | null {
    return currentActions;
  },
  setController(c: CompactController | null): void {
    controller = c;
  },
  requestCompact(): void {
    controller?.enter();
  },
};
