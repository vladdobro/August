import fs from 'node:fs';
import path from 'node:path';

import type { Rectangle } from 'electron';

/// Main window size/position remembered between launches as <userData>/window-state.json. Kept out of
/// desktop-settings.json because the renderer reads that file through the settings bridge.
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

export function writeWindowState(userDataDir: string, state: WindowState): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'window-state.json'), JSON.stringify(state, null, 2));
  } catch {
    // best effort — a failed write only means the next launch uses the default size
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
