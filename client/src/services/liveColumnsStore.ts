// AUG-199: layout of the side columns next to the live transcript (ACTION ITEMS / COPILOT / ASSISTANT).
// Client preference, remembered per window size class in localStorage (never on the server).
// AUG-205: the layout is fitted to the panel width. When the open columns plus the 360 px canvas do not fit,
// the lowest-priority column (COPILOT, then ASSISTANT, then ACTION ITEMS) collapses to its rail; below
// SINGLE_COLUMN_BELOW only one column is expanded at a time. A column the user opens stays open and the
// others give way; auto-collapsed columns get their width back when room returns.
import { useSyncExternalStore } from 'react';

export type ColumnKey = 'ai' | 'cp' | 'as';
/// `auto`: collapsed by the fitting rule, not by the user; re-expands when there is room again.
export interface ColumnLayout { show: boolean; collapsed: boolean; width: number; auto?: boolean }
export interface LiveColumnsState { columns: Record<ColumnKey, ColumnLayout>; liveVisible: boolean; transcript: boolean }

export const COLUMN_MIN_WIDTH = 240;
export const COLUMN_MAX_WIDTH = 560;
export const CANVAS_MIN_WIDTH = 360;
export const RAIL_WIDTH = 28;
/// AUG-205: below this panel width only one side column is expanded at a time (the others are rails).
export const SINGLE_COLUMN_BELOW = 1100;
/// Below this width App.css stacks the columns under the canvas (@media max-width: 900px): no fitting there.
const STACKED_BELOW = 900;
export const COLUMN_TITLES: Record<ColumnKey, string> = { ai: 'ACTION ITEMS', cp: 'COPILOT', as: 'ASSISTANT' };
const DEFAULT_WIDTH: Record<ColumnKey, number> = { ai: 300, cp: 300, as: 380 };
const KEYS: ColumnKey[] = ['ai', 'cp', 'as'];
/// Lowest priority first: the first expanded one in this order collapses first.
const COLLAPSE_ORDER: ColumnKey[] = ['cp', 'as', 'ai'];

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
        auto: c.auto === true,
      };
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return out;
}

/// AUG-205: pure fitting rule. `available` = width of .live-panel-main; `present` = columns rendered at all
/// (COPILOT is absent on the meeting-only socket); `keep` = the column the user just opened (never collapsed here).
export function fitLayout(
  columns: Record<ColumnKey, ColumnLayout>,
  available: number,
  present: ColumnKey[],
  keep?: ColumnKey,
): Record<ColumnKey, ColumnLayout> {
  if (!(available >= STACKED_BELOW)) return columns;
  const out = { ...columns };
  const widthOf = (k: ColumnKey) => (!present.includes(k) || !out[k].show ? 0 : out[k].collapsed ? RAIL_WIDTH : out[k].width);
  const used = () => KEYS.reduce((s, k) => s + widthOf(k), 0) + CANVAS_MIN_WIDTH;
  const expanded = () => KEYS.filter((k) => present.includes(k) && out[k].show && !out[k].collapsed);
  const maxExpanded = available < SINGLE_COLUMN_BELOW ? 1 : KEYS.length;
  const over = () => used() > available || expanded().length > maxExpanded;
  // 1. collapse the lowest-priority expanded columns until the layout fits
  for (const k of COLLAPSE_ORDER) {
    if (!over()) break;
    if (k === keep || !present.includes(k) || !out[k].show || out[k].collapsed) continue;
    out[k] = { ...out[k], collapsed: true, auto: true };
  }
  // 2. give auto-collapsed columns their width back when there is room, highest priority first
  for (const k of [...COLLAPSE_ORDER].reverse()) {
    if (!present.includes(k) || !out[k].show || !out[k].collapsed || !out[k].auto) continue;
    if (expanded().length + 1 > maxExpanded) continue;
    if (used() - RAIL_WIDTH + out[k].width > available) continue;
    out[k] = { ...out[k], collapsed: false, auto: false };
  }
  return out;
}

let currentClass = sizeClass();
/// Width of .live-panel-main, reported by LiveTranscriptPanel's ResizeObserver; window width until then.
let available = typeof window === 'undefined' ? 1440 : window.innerWidth;
let state: LiveColumnsState = { columns: fitLayout(load(currentClass), available, KEYS), liveVisible: false, transcript: false };
const listeners = new Set<() => void>();

const present = (): ColumnKey[] => (state.transcript ? KEYS : ['ai', 'as']);
const same = (a: Record<ColumnKey, ColumnLayout>, b: Record<ColumnKey, ColumnLayout>) => JSON.stringify(a) === JSON.stringify(b);

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

/// Every layout change goes through the fitting rule, then is persisted and published.
function apply(next: Record<ColumnKey, ColumnLayout>, keep?: ColumnKey): void {
  const fitted = fitLayout(next, available, present(), keep);
  if (same(fitted, state.columns)) return;
  state = { ...state, columns: fitted };
  persist();
  emit();
}

function patch(k: ColumnKey, p: Partial<ColumnLayout>, keep?: ColumnKey): void {
  apply({ ...state.columns, [k]: { ...state.columns[k], ...p } }, keep);
}

// The layout belongs to the window size class: crossing a class boundary loads that class's layout.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const cls = sizeClass();
    if (cls === currentClass) return;
    currentClass = cls;
    state = { ...state, columns: fitLayout(load(cls), available, present()) };
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
    else patch(k, { show: true, collapsed: false, auto: false }, k);
  },
  show(k: ColumnKey): void {
    patch(k, { show: true, collapsed: false, auto: false }, k);
  },
  hide(k: ColumnKey): void {
    patch(k, { show: false });
  },
  collapse(k: ColumnKey): void {
    patch(k, { collapsed: true, auto: false });
  },
  expand(k: ColumnKey): void {
    patch(k, { collapsed: false, auto: false }, k);
  },
  setWidth(k: ColumnKey, w: number): void {
    const width = clampWidth(w);
    if (width !== state.columns[k].width) patch(k, { width }, k);
  },
  resetWidth(k: ColumnKey): void {
    patch(k, { width: DEFAULT_WIDTH[k] }, k);
  },
  /// AUG-205: LiveTranscriptPanel reports the width of .live-panel-main; 0 = panel unmounted (window width again).
  setAvailable(w: number): void {
    const next = w > 0 ? Math.round(w) : typeof window === 'undefined' ? 1440 : window.innerWidth;
    if (next === available) return;
    available = next;
    apply(state.columns);
  },
  /// FileUpload sets this while the live panel is mounted; the pin-bar toggles render only then.
  /// AUG-200: COPILOT needs a transcript, so `transcript` is false on the meeting-only socket.
  setLiveVisible(v: boolean, transcript = v): void {
    if (state.liveVisible === v && state.transcript === transcript) return;
    state = { ...state, liveVisible: v, transcript };
    emit();
    apply(state.columns); // the set of present columns changed: refit
  },
};

export function useLiveColumns(): LiveColumnsState {
  return useSyncExternalStore(liveColumnsStore.subscribe, liveColumnsStore.getSnapshot);
}
