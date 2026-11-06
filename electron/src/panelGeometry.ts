/// AUG-199: placement rules for the compact Copilot / Assistant windows: snap to near edges (12 px), never overlap
/// another compact window. Pure (no electron import, no platform branches); port of the mockup's snapR / freeSpot.
export interface Rect { x: number; y: number; width: number; height: number }

export const SNAP_T = 12;
const SCAN_STEP = 10;

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/// Fully inside the work area; a rect larger than the area is shrunk to it.
export function clampInto(r: Rect, wa: Rect): Rect {
  const width = Math.min(r.width, wa.width);
  const height = Math.min(r.height, wa.height);
  const x = Math.min(Math.max(r.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(r.y, wa.y), wa.y + wa.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/// Each edge snaps to the work-area edges and to other windows' edges within T px; the nearest candidate wins per axis.
export function snapRect(r: Rect, others: Rect[], wa: Rect, T = SNAP_T): Rect {
  let bx: number | null = null;
  let by: number | null = null;
  const tryX = (a: number, b: number): void => {
    const d = b - a;
    if (Math.abs(d) <= T && (bx === null || Math.abs(d) < Math.abs(bx))) bx = d;
  };
  const tryY = (a: number, b: number): void => {
    const d = b - a;
    if (Math.abs(d) <= T && (by === null || Math.abs(d) < Math.abs(by))) by = d;
  };
  tryX(r.x, wa.x);
  tryX(r.x + r.width, wa.x + wa.width);
  tryY(r.y, wa.y);
  tryY(r.y + r.height, wa.y + wa.height);
  for (const c of others) {
    tryX(r.x, c.x);
    tryX(r.x, c.x + c.width);
    tryX(r.x + r.width, c.x);
    tryX(r.x + r.width, c.x + c.width);
    tryY(r.y, c.y);
    tryY(r.y, c.y + c.height);
    tryY(r.y + r.height, c.y);
    tryY(r.y + r.height, c.y + c.height);
  }
  return clampInto({ ...r, x: r.x + (bx ?? 0), y: r.y + (by ?? 0) }, wa);
}

function freeAt(r: Rect, others: Rect[]): boolean {
  return !others.some((o) => rectsOverlap(r, o));
}

/// Moves `r` to the nearest free spot: beside the first window it overlaps (right, below, left, above), else the free
/// spot nearest to `r` on a 10 px scan of the work area; nothing free -> `r` clamped.
export function resolveOverlap(r: Rect, others: Rect[], wa: Rect): Rect {
  const base = clampInto(r, wa);
  const hit = others.find((o) => rectsOverlap(base, o));
  if (!hit) return base;
  const tries: Array<{ x: number; y: number }> = [
    { x: hit.x + hit.width, y: base.y },
    { x: base.x, y: hit.y + hit.height },
    { x: hit.x - base.width, y: base.y },
    { x: base.x, y: hit.y - base.height },
  ];
  for (const t of tries) {
    const p = clampInto({ x: t.x, y: t.y, width: base.width, height: base.height }, wa);
    if (freeAt(p, others)) return p;
  }
  let best: Rect | null = null;
  let bestDist = Infinity;
  for (let y = wa.y; y <= wa.y + wa.height - base.height; y += SCAN_STEP) {
    for (let x = wa.x; x <= wa.x + wa.width - base.width; x += SCAN_STEP) {
      const p = { x, y, width: base.width, height: base.height };
      if (!freeAt(p, others)) continue;
      const d = Math.abs(x - base.x) + Math.abs(y - base.y);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }
  return best ?? base;
}
