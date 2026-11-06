import fs from 'node:fs';
import path from 'node:path';

import type { Rectangle } from 'electron';

import { parseGhostWindowState, type GhostWindowState } from './ghostGeometry.js';

/// Main window size/position remembered between launches as <userData>/window-state.json. Kept out of
/// desktop-settings.json because the renderer reads that file through the settings bridge.
/// The file also holds an optional `ghost` record (AUG-187: saved Ghost Mode caption / coin placement),
/// written by the main process; writeWindowState preserves it. AUG-199 adds a `panels` record (saved compact
/// Copilot / Assistant window bounds), preserved the same way.
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const WINDOW_MIN_SIZE = { width: 960, height: 600 } as const;
// A saved window must keep at least this much of itself on some display, or it is treated as off-screen.
const MIN_VISIBLE = 100;

function isWindowState(value: unknown): value is WindowState {
  const v = value as Partial<WindowState> | null;
  return !!v
    && [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    && typeof v.maximized === 'boolean';
}

export function readWindowState(userDataDir: string): WindowState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(userDataDir, 'window-state.json'), 'utf-8'));
    return isWindowState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRaw(userDataDir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(userDataDir, 'window-state.json'), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function writeWindowState(userDataDir: string, state: WindowState): void {
  try {
    const prev = readRaw(userDataDir);
    const ghost = prev ? parseGhostWindowState(prev.ghost) : {};
    const panels = prev ? parsePanelState(prev.panels) : {};
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'window-state.json'),
      JSON.stringify(
        {
          ...state,
          ...(Object.keys(ghost).length ? { ghost } : {}),
          ...(Object.keys(panels).length ? { panels } : {}),
        },
        null,
        2,
      ),
    );
  } catch {
    // best effort — a failed write only means the next launch uses the default size
  }
}

export function readGhostState(userDataDir: string): GhostWindowState {
  return parseGhostWindowState(readRaw(userDataDir)?.ghost);
}

/// Saves (or, with null / an empty record, clears) the Ghost Mode placement without touching the window bounds.
export function writeGhostState(userDataDir: string, ghost: GhostWindowState | null): void {
  try {
    const raw = readRaw(userDataDir) ?? {};
    if (!ghost || Object.keys(ghost).length === 0) delete raw.ghost;
    else raw.ghost = ghost;
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'window-state.json'), JSON.stringify(raw, null, 2));
  } catch {
    // best effort — a failed write only means the ghost returns to its default spot
  }
}

export type PanelKind = 'copilot' | 'assistant';
export type PanelState = Partial<Record<PanelKind, { x: number; y: number; width: number; height: number }>>;

function parsePanelState(v: unknown): PanelState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const rec = v as Record<string, unknown>;
  const out: PanelState = {};
  for (const kind of ['copilot', 'assistant'] as const) {
    const r = rec[kind] as Partial<{ x: number; y: number; width: number; height: number }> | undefined;
    if (r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)) && r.width! > 0 && r.height! > 0) {
      out[kind] = { x: r.x!, y: r.y!, width: r.width!, height: r.height! };
    }
  }
  return out;
}

export function readPanelState(userDataDir: string): PanelState {
  return parsePanelState(readRaw(userDataDir)?.panels);
}

/// Saves (or, with an empty record, clears) the compact panel bounds without touching the other keys.
export function writePanelState(userDataDir: string, panels: PanelState): void {
  try {
    const raw = readRaw(userDataDir) ?? {};
    if (Object.keys(panels).length === 0) delete raw.panels;
    else raw.panels = panels;
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'window-state.json'), JSON.stringify(raw, null, 2));
  } catch {
    // best effort — a failed write only means the panels return to their default spots
  }
}

/// Fits saved bounds onto the current displays: null when no display shows at least MIN_VISIBLE px of the window
/// (monitor unplugged, resolution changed), otherwise the bounds clamped to the best-matching work area and to the
/// minimum window size. Pure, so the display layout is injectable in tests.
export function fitWindowState(saved: WindowState | null, workAreas: Rectangle[]): WindowState | null {
  if (!saved) return null;
  let best: { area: Rectangle; overlap: number } | null = null;
  for (const area of workAreas) {
    const w = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const h = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
    if (w >= MIN_VISIBLE && h >= MIN_VISIBLE && (!best || w * h > best.overlap)) best = { area, overlap: w * h };
  }
  if (!best) return null;
  const { area } = best;
  const width = Math.max(WINDOW_MIN_SIZE.width, Math.min(saved.width, area.width));
  const height = Math.max(WINDOW_MIN_SIZE.height, Math.min(saved.height, area.height));
  const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height);
  return { x, y, width, height, maximized: saved.maximized };
}
