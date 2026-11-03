/// Ghost Mode geometry (AUG-187): release rule A (magnetic edges), clamp, coin hover expansion and the saved
/// placement record. Pure (no electron runtime import) so the display layout is injectable in tests.
import type { Rectangle } from 'electron';

export type GhostWidgetKind = 'caption' | 'coin';
export interface GhostDisplay { id: number; workArea: Rectangle }
export interface GhostPlacement {
  displayId: number;
  hAnchor: 'left' | 'right';
  hOffset: number;
  vAnchor: 'top' | 'bottom';
  vOffset: number;
}
export type GhostWindowState = Partial<Record<GhostWidgetKind, GhostPlacement>>;

export const SNAP_DIP = 32;
export const GHOST_MARGIN: Record<GhostWidgetKind, number> = { caption: 24, coin: 16 };

/// Fully inside the work area; a rect larger than the area is shrunk to it.
export function clampRectInto(r: Rectangle, wa: Rectangle): Rectangle {
  const width = Math.min(r.width, wa.width);
  const height = Math.min(r.height, wa.height);
  const x = Math.min(Math.max(r.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(r.y, wa.y), wa.y + wa.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/// Release rule A: within `threshold` of an edge the rect snaps to that edge plus the margin; two near edges give a corner.
export function snapRelease(r: Rectangle, wa: Rectangle, margin: number, threshold = SNAP_DIP): Rectangle {
  const c = clampRectInto(r, wa);
  const dl = c.x - wa.x;
  const dr = wa.x + wa.width - (c.x + c.width);
  const dt = c.y - wa.y;
  const db = wa.y + wa.height - (c.y + c.height);
  let { x, y } = c;
  if (Math.min(dl, dr) <= threshold) x = dl <= dr ? wa.x + margin : wa.x + wa.width - c.width - margin;
  if (Math.min(dt, db) <= threshold) y = dt <= db ? wa.y + margin : wa.y + wa.height - c.height - margin;
  // the margin may not fit on a tiny work area
  return clampRectInto({ x, y, width: c.width, height: c.height }, wa);
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/// The display overlapping `r` the most; with no overlap, the one whose work-area center is nearest to r's center.
export function pickDisplay(displays: GhostDisplay[], r: Rectangle): GhostDisplay {
  let best = displays[0];
  let bestOverlap = -1;
  for (const d of displays) {
    const o = overlapArea(d.workArea, r);
    if (o > bestOverlap) {
      best = d;
      bestOverlap = o;
    }
  }
  if (bestOverlap > 0) return best;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  let bestDist = Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    const dist = Math.hypot(wa.x + wa.width / 2 - cx, wa.y + wa.height / 2 - cy);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/// Saved placement: offsets in DIP from the nearest edge on each axis.
export function placementFromRect(r: Rectangle, display: GhostDisplay): GhostPlacement {
  const wa = display.workArea;
  const left = r.x - wa.x;
  const right = wa.x + wa.width - (r.x + r.width);
  const top = r.y - wa.y;
  const bottom = wa.y + wa.height - (r.y + r.height);
  return {
    displayId: display.id,
    hAnchor: left <= right ? 'left' : 'right',
    hOffset: Math.max(0, Math.round(Math.min(left, right))),
    vAnchor: top <= bottom ? 'top' : 'bottom',
    vOffset: Math.max(0, Math.round(Math.min(top, bottom))),
  };
}

export function rectFromPlacement(p: GhostPlacement, size: { width: number; height: number }, wa: Rectangle): Rectangle {
  const x = p.hAnchor === 'left' ? wa.x + p.hOffset : wa.x + wa.width - size.width - p.hOffset;
  const y = p.vAnchor === 'top' ? wa.y + p.vOffset : wa.y + wa.height - size.height - p.vOffset;
  return clampRectInto({ x, y, width: size.width, height: size.height }, wa);
}

export function defaultGhostRect(kind: GhostWidgetKind, size: { width: number; height: number }, wa: Rectangle): Rectangle {
  if (kind === 'caption') {
    return clampRectInto({
      x: wa.x + Math.round((wa.width - size.width) / 2),
      y: wa.y + wa.height - size.height - GHOST_MARGIN.caption,
      width: size.width,
      height: size.height,
    }, wa);
  }
  return clampRectInto({
    x: wa.x + wa.width - size.width - GHOST_MARGIN.coin,
    y: wa.y + wa.height - size.height - GHOST_MARGIN.coin,
    width: size.width,
    height: size.height,
  }, wa);
}

/// Saved display by id; an unplugged one falls back to the display best matching `fallback`, else the first (primary).
export function resolveGhostDisplay(p: GhostPlacement | undefined, displays: GhostDisplay[], fallback: Rectangle | null): GhostDisplay {
  if (p) {
    const found = displays.find((d) => d.id === p.displayId);
    if (found) return found;
  }
  if (fallback) return pickDisplay(displays, fallback);
  return displays[0];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isGhostPlacement(v: unknown): v is GhostPlacement {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return isFiniteNumber(p.displayId)
    && (p.hAnchor === 'left' || p.hAnchor === 'right')
    && (p.vAnchor === 'top' || p.vAnchor === 'bottom')
    && isFiniteNumber(p.hOffset) && p.hOffset >= 0
    && isFiniteNumber(p.vOffset) && p.vOffset >= 0;
}

/// A malformed record is dropped, never thrown on.
export function parseGhostWindowState(v: unknown): GhostWindowState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const rec = v as Record<string, unknown>;
  const out: GhostWindowState = {};
  if (isGhostPlacement(rec.caption)) out.caption = rec.caption;
  if (isGhostPlacement(rec.coin)) out.coin = rec.coin;
  return out;
}

/// Which side of the window the coin face sits on while hovered: the window grows toward the screen middle,
/// flipping when that side has no room. The renderer mirrors this rule (GhostApp), keep both identical.
export function coinFaceSide(faceX: number, faceWidth: number, width: number, waX: number, waWidth: number): 'left' | 'right' {
  let right = faceX + faceWidth / 2 > waX + waWidth / 2;
  const fitsLeftGrowth = faceX + faceWidth - width >= waX;
  const fitsRightGrowth = faceX + width <= waX + waWidth;
  if (right && !fitsLeftGrowth && fitsRightGrowth) right = false;
  else if (!right && !fitsRightGrowth && fitsLeftGrowth) right = true;
  return right ? 'right' : 'left';
}

/// Expanded coin window grown from the collapsed face; the face never moves (only y is clamped into the work area).
export function coinExpandedRect(
  face: Rectangle,
  width: number,
  wa: Rectangle,
  prefer?: 'left' | 'right',
): { rect: Rectangle; faceSide: 'left' | 'right' } {
  let faceSide: 'left' | 'right' = prefer ?? coinFaceSide(face.x, face.width, width, wa.x, wa.width);
  const fitsLeftGrowth = face.x + face.width - width >= wa.x;
  const fitsRightGrowth = face.x + width <= wa.x + wa.width;
  if (faceSide === 'right' && !fitsLeftGrowth && fitsRightGrowth) faceSide = 'left';
  else if (faceSide === 'left' && !fitsRightGrowth && fitsLeftGrowth) faceSide = 'right';
  const x = faceSide === 'right' ? face.x + face.width - width : face.x;
  const y = Math.min(Math.max(face.y, wa.y), wa.y + wa.height - face.height);
  return { rect: { x, y, width, height: face.height }, faceSide };
}
