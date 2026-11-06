// AUG-199: layout of the side columns next to the live transcript (ACTION ITEMS / COPILOT / ASSISTANT).
// Client preference, remembered per window size class in localStorage (never on the server).
import { useSyncExternalStore } from 'react';

export type ColumnKey = 'ai' | 'cp' | 'as';
export interface ColumnLayout { show: boolean; collapsed: boolean; width: number }
export interface LiveColumnsState { columns: Record<ColumnKey, ColumnLayout>; liveVisible: boolean; transcript: boolean }

export const COLUMN_MIN_WIDTH = 240;
export const COLUMN_MAX_WIDTH = 560;
export const CANVAS_MIN_WIDTH = 360;
export const COLUMN_TITLES: Record<ColumnKey, string> = { ai: 'ACTION ITEMS', cp: 'COPILOT', as: 'ASSISTANT' };
const DEFAULT_WIDTH: Record<ColumnKey, number> = { ai: 300, cp: 300, as: 380 };
const KEYS: ColumnKey[] = ['ai', 'cp', 'as'];

function sizeClass(): 's' | 'm' | 'l' {
  const w = typeof window === 'undefined' ? 1440 : window.innerWidth;
  return w < 1280 ? 's' : w < 1680 ? 'm' : 'l';
}

const storageKey = (cls: string) => `august.liveColumns.v1.${cls}`;
const clampWidth = (w: number) => Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, Math.round(w)));

function defaults(): Record<ColumnKey, ColumnLayout> {
  return {
    ai: { show: true, collapsed: false, width: DEFAULT_WIDTH.ai },
    cp: { show: true, collapsed: false, width: DEFAULT_WIDTH.cp },
    as: { show: true, collapsed: false, width: DEFAULT_WIDTH.as },
  };
}

function load(cls: string): Record<ColumnKey, ColumnLayout> {
  const out = defaults();
  try {
    const raw = window.localStorage.getItem(storageKey(cls));
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, Partial<ColumnLayout>>>;
    for (const k of KEYS) {
      const c = parsed?.[k];
      if (!c || typeof c !== 'object') continue;
      out[k] = {
        show: typeof c.show === 'boolean' ? c.show : true,
        collapsed: typeof c.collapsed === 'boolean' ? c.collapsed : false,
        width: typeof c.width === 'number' && Number.isFinite(c.width) ? clampWidth(c.width) : DEFAULT_WIDTH[k],
      };
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return out;
}

let currentClass = sizeClass();
let state: LiveColumnsState = { columns: load(currentClass), liveVisible: false, transcript: false };
const listeners = new Set<() => void>();

function persist(): void {
  try {
    window.localStorage.setItem(storageKey(currentClass), JSON.stringify(state.columns));
  } catch {
    // ignore
  }
}

function emit(): void {
  listeners.forEach((l) => l());
}

function patch(k: ColumnKey, p: Partial<ColumnLayout>): void {
  state = { ...state, columns: { ...state.columns, [k]: { ...state.columns[k], ...p } } };
  persist();
  emit();
}

// The layout belongs to the window size class: crossing a class boundary loads that class's layout.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const cls = sizeClass();
    if (cls === currentClass) return;
    currentClass = cls;
    state = { ...state, columns: load(cls) };
    emit();
  });
}

export const liveColumnsStore = {
  getSnapshot(): LiveColumnsState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  toggle(k: ColumnKey): void {
    const c = state.columns[k];
    if (c.show) patch(k, { show: false });
    else patch(k, { show: true, collapsed: false });
  },
  show(k: ColumnKey): void {
    patch(k, { show: true, collapsed: false });
  },
  hide(k: ColumnKey): void {
    patch(k, { show: false });
  },
  collapse(k: ColumnKey): void {
    patch(k, { collapsed: true });
  },
  expand(k: ColumnKey): void {
    patch(k, { collapsed: false });
  },
  setWidth(k: ColumnKey, w: number): void {
    const width = clampWidth(w);
    if (width !== state.columns[k].width) patch(k, { width });
  },
  resetWidth(k: ColumnKey): void {
    patch(k, { width: DEFAULT_WIDTH[k] });
  },
  /// FileUpload sets this while the live panel is mounted; the pin-bar toggles render only then.
  /// AUG-200: COPILOT needs a transcript, so `transcript` is false on the meeting-only socket.
  setLiveVisible(v: boolean, transcript = v): void {
    if (state.liveVisible === v && state.transcript === transcript) return;
    state = { ...state, liveVisible: v, transcript };
    emit();
  },
};

export function useLiveColumns(): LiveColumnsState {
  return useSyncExternalStore(liveColumnsStore.subscribe, liveColumnsStore.getSnapshot);
}
