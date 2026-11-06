/// Compact Mode (AUG-156): shrinks the main window into a right-edge strip or a corner square, or hides it
/// behind a transparent always-on-top "ghost" window (caption bar / coin). The renderer owns the compact state;
/// this controller only moves windows, remembers the full-size bounds and tells the renderer about user resizes.
import { BrowserWindow, screen, type Point, type Rectangle, type WebContents } from 'electron';

import {
  GHOST_MARGIN,
  clampRectInto,
  coinExpandedRect,
  defaultGhostRect,
  placementFromRect,
  rectFromPlacement,
  resolveGhostDisplay,
  snapRelease,
  type GhostDisplay,
  type GhostWindowState,
} from './ghostGeometry.js';
import { clampInto, rectsOverlap, resolveOverlap, snapRect, type Rect } from './panelGeometry.js';
import { readGhostState, readPanelState, writeGhostState, writePanelState, type PanelKind, type PanelState } from './windowState.js';

export type CompactShape = 'none' | 'strip' | 'square' | 'caption' | 'coin';
export interface CompactRequest {
  shape: CompactShape;
  stripWidth?: number;
  captionHeight?: number;
  captionWidth?: number;
  alwaysOnTop?: boolean;
}
export type CompactEvent =
  | { type: 'expand' }
  | { type: 'toggle' }
  | { type: 'strip-width'; width: number }
  | { type: 'caption-height'; height: number }
  | { type: 'caption-width'; width: number };

type GhostShape = 'caption' | 'coin';

const STRIP_MIN = 280;
const STRIP_MAX = 520;
const STRIP_EXIT = 600;
const SQUARE = 180;
const SQUARE_MARGIN = 12;
const COIN = 56;
// Ghost Caption is user-resizable: height 72-480 from its inner edge (prefs compactCaptionHeight) and width 320-760
// from its left/right edges (prefs compactCaptionWidth); same ranges on the server.
const CAPTION_MIN_W = 320;
const CAPTION_MAX_W = 760;
const CAPTION_H = 112;
const CAPTION_MIN_H = 72;
const CAPTION_MAX_H = 480;
const CAPTION_MARGIN = 24;
// Must equal createWindow's minWidth/minHeight in main.ts.
const FULL_MIN_W = 960;
const FULL_MIN_H = 600;

// AUG-199: compact Copilot / Assistant windows.
const PANEL_KINDS: readonly PanelKind[] = ['copilot', 'assistant'];
const PANEL_DEFAULT: Record<PanelKind, { width: number; height: number }> = {
  copilot: { width: 340, height: 220 },
  assistant: { width: 360, height: 420 },
};
const PANEL_MIN: Record<PanelKind, { width: number; height: number }> = {
  copilot: { width: 260, height: 140 },
  assistant: { width: 280, height: 240 },
};
const PANEL_GAP = 12;
const PANEL_SETTLE_MS = 250;

export function isPanelKind(value: unknown): value is PanelKind {
  return value === 'copilot' || value === 'assistant';
}

const SHAPES: readonly string[] = ['none', 'strip', 'square', 'caption', 'coin'];

/// Validates an untrusted IPC payload; returns null when the shape is unknown or a field has the wrong type.
export function parseCompactRequest(value: unknown): CompactRequest | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.shape !== 'string' || !SHAPES.includes(rec.shape)) return null;
  const req: CompactRequest = { shape: rec.shape as CompactShape };
  if (rec.stripWidth !== undefined) {
    if (typeof rec.stripWidth !== 'number' || !Number.isFinite(rec.stripWidth)) return null;
    req.stripWidth = rec.stripWidth;
  }
  if (rec.captionHeight !== undefined) {
    if (typeof rec.captionHeight !== 'number' || !Number.isFinite(rec.captionHeight)) return null;
    req.captionHeight = rec.captionHeight;
  }
  if (rec.captionWidth !== undefined) {
    if (typeof rec.captionWidth !== 'number' || !Number.isFinite(rec.captionWidth)) return null;
    req.captionWidth = rec.captionWidth;
  }
  if (rec.alwaysOnTop !== undefined) {
    if (typeof rec.alwaysOnTop !== 'boolean') return null;
    req.alwaysOnTop = rec.alwaysOnTop;
  }
  return req;
}

/// macOS needs the 'floating' level plus all-workspaces visibility to stay above a full-screen call; Windows needs only the flag.
function applyOnTop(win: BrowserWindow, on: boolean): void {
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(on, 'floating');
    win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(on);
  }
}

/// Keeps a rectangle inside the work area of the display it overlaps most; an unplugged display resolves to the nearest one.
function clampToWorkArea(b: Rectangle): Rectangle {
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  return { x, y, width, height };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface CompactControllerOptions {
  window: BrowserWindow;
  appUrl: string;
  preloadPath: string;
  devTools: boolean;
  userDataDir: string;
  onShapeChange(shape: CompactShape): void;
  sendEvent(event: CompactEvent): void;
  /// Which compact panels are visible now (AUG-199); main forwards it to the renderers.
  onPanelsChange?(state: { copilot: boolean; assistant: boolean }): void;
}

export interface CompactResult {
  ok: boolean;
  shape: CompactShape;
  error?: string;
}

export class CompactController {
  private current: CompactShape = 'none';
  private snapshot: { bounds: Rectangle; maximized: boolean } | null = null;
  private ghost: BrowserWindow | null = null;
  private ghostShape: GhostShape | null = null;
  private captionHeight = CAPTION_H;
  private captionWidth: number = CAPTION_MAX_W;
  private coinFace: Rectangle | null = null; // collapsed 56x56 face; the hover expansion grows from it
  private saved: GhostWindowState; // saved placement per widget (AUG-187), loaded from window-state.json
  private applying = false;
  private drag: { cursor: Point; bounds: Rectangle } | null = null;
  private resize: {
    cursor: Point;
    bounds: Rectangle;
    edge: 'height' | 'left' | 'right';
    fixed: 'top' | 'bottom';
    minHeight: number;
  } | null = null;
  private panels: Partial<Record<PanelKind, BrowserWindow>> = {};
  private panelOn: Record<PanelKind, boolean> = { copilot: false, assistant: false };
  private savedPanels: PanelState; // saved bounds per panel (AUG-199), loaded from window-state.json
  private panelTimers: Partial<Record<PanelKind, ReturnType<typeof setTimeout>>> = {};
  private readonly onDisplaysChanged = (): void => {
    this.reclampGhost();
    this.reclampPanels();
  };

  constructor(private readonly opts: CompactControllerOptions) {
    const win = opts.window;
    this.saved = readGhostState(opts.userDataDir);
    this.savedPanels = readPanelState(opts.userDataDir);
    win.on('resized', () => this.onUserResize());
    win.on('maximize', () => this.onUserResize());
    screen.on('display-removed', this.onDisplaysChanged);
    screen.on('display-metrics-changed', this.onDisplaysChanged);
  }

  get shape(): CompactShape {
    return this.current;
  }

  /// Normal-window bounds saved when compact mode was entered; null while not compact.
  get normalSnapshot(): { bounds: Rectangle; maximized: boolean } | null {
    return this.snapshot ? { bounds: { ...this.snapshot.bounds }, maximized: this.snapshot.maximized } : null;
  }

  isGhostSender(wc: WebContents): boolean {
    return this.ghost !== null && !this.ghost.isDestroyed() && this.ghost.webContents === wc;
  }

  isPanelSender(wc: WebContents): boolean {
    return PANEL_KINDS.some((k) => {
      const w = this.panels[k];
      return !!w && !w.isDestroyed() && w.webContents === wc;
    });
  }

  /// Web contents of the ghost window and the panel windows, for broadcasting panel state.
  auxContents(): WebContents[] {
    const out: WebContents[] = [];
    if (this.ghost && !this.ghost.isDestroyed()) out.push(this.ghost.webContents);
    for (const k of PANEL_KINDS) {
      const w = this.panels[k];
      if (w && !w.isDestroyed()) out.push(w.webContents);
    }
    return out;
  }

  panelState(): { copilot: boolean; assistant: boolean } {
    return { copilot: this.panelVisible('copilot'), assistant: this.panelVisible('assistant') };
  }

  /// Shows or hides a compact panel window; only while compact. Hidden panels are kept (bounds and page state).
  setPanel(kind: PanelKind, visible: boolean): void {
    if (this.current === 'none') return;
    const existing = this.panels[kind];
    if (!visible) {
      if (existing && !existing.isDestroyed()) existing.hide();
      this.panelOn[kind] = false;
      this.notifyPanels();
      return;
    }
    this.panelOn[kind] = true;
    if (existing && !existing.isDestroyed()) {
      this.guarded(() => existing.setBounds(this.placePanel(kind, existing.getBounds())));
      existing.showInactive();
    } else {
      this.createPanel(kind);
    }
    this.notifyPanels();
  }

  apply(req: CompactRequest): CompactResult {
    try {
      const win = this.opts.window;
      if (win.isDestroyed()) return { ok: false, shape: this.current, error: 'Window destroyed' };

      if (this.current === 'none' && req.shape !== 'none') {
        const maximized = win.isMaximized();
        this.snapshot = {
          bounds: maximized || win.isFullScreen() ? win.getNormalBounds() : win.getBounds(),
          maximized,
        };
        if (win.isFullScreen()) win.setFullScreen(false);
        if (maximized) win.unmaximize();
      }

      const alreadyCompact = this.current === 'strip' || this.current === 'square';
      const reference =
        (req.shape === 'strip' || req.shape === 'square') && alreadyCompact
          ? win.getBounds()
          : (this.snapshot?.bounds ?? win.getBounds());
      const wa = screen.getDisplayMatching(reference).workArea;

      switch (req.shape) {
        case 'strip': {
          this.destroyGhost();
          const w = clamp(Math.round(req.stripWidth ?? 360), STRIP_MIN, STRIP_MAX);
          win.setResizable(true);
          win.setMinimumSize(STRIP_MIN, 240);
          this.guarded(() => win.setBounds({ x: wa.x + wa.width - w, y: wa.y, width: w, height: wa.height }));
          applyOnTop(win, req.alwaysOnTop !== false);
          if (!win.isVisible()) win.show();
          break;
        }
        case 'square': {
          this.destroyGhost();
          win.setMinimumSize(120, 120);
          win.setResizable(false);
          this.guarded(() => {
            win.setContentSize(SQUARE, SQUARE);
            const b = win.getBounds();
            win.setPosition(wa.x + wa.width - b.width - SQUARE_MARGIN, wa.y + wa.height - b.height - SQUARE_MARGIN);
          });
          applyOnTop(win, req.alwaysOnTop !== false);
          if (!win.isVisible()) win.show();
          break;
        }
        case 'caption':
        case 'coin': {
          if (req.shape === 'caption' && req.captionHeight !== undefined) {
            this.captionHeight = clamp(Math.round(req.captionHeight), CAPTION_MIN_H, CAPTION_MAX_H);
          }
          if (req.shape === 'caption' && req.captionWidth !== undefined) {
            this.captionWidth = clamp(Math.round(req.captionWidth), CAPTION_MIN_W, CAPTION_MAX_W);
          }
          applyOnTop(win, false);
          win.hide();
          this.ensureGhost(req.shape);
          break;
        }
        case 'none': {
          this.restore();
          break;
        }
      }

      if (req.shape !== this.current) {
        this.current = req.shape;
        this.opts.onShapeChange(this.current);
      }
      if (this.current !== 'none') this.relayoutPanels();
      return { ok: true, shape: this.current };
    } catch (err) {
      return { ok: false, shape: this.current, error: err instanceof Error ? err.message : String(err) };
    }
  }

  ghostSetIgnoreMouse(ignore: boolean): void {
    if (this.ghostShape !== 'caption' || !this.ghost || this.ghost.isDestroyed()) return;
    this.ghost.setIgnoreMouseEvents(ignore, { forward: true });
  }

  /// Coin hover expansion: the window grows from the collapsed face toward the screen middle (or `faceSide`'s
  /// opposite when the renderer passes it), so the face never moves.
  ghostResize(size: { width: number; height: number }, faceSide?: 'left' | 'right'): void {
    const ghost = this.ghost;
    if (this.ghostShape !== 'coin' || !ghost || ghost.isDestroyed()) return;
    const width = clamp(Math.round(size.width), COIN, 380);
    const height = clamp(Math.round(size.height), COIN, 120);
    if (!this.coinFace) {
      const b = ghost.getBounds();
      this.coinFace = { x: b.x, y: b.y, width: COIN, height: COIN };
    }
    const face = this.coinFace;
    const wa = screen.getDisplayMatching(face).workArea;
    if (width <= COIN) {
      ghost.setBounds({ ...face, width: COIN, height: COIN });
      return;
    }
    const { rect } = coinExpandedRect({ ...face, width: COIN, height: COIN }, width, wa, faceSide);
    ghost.setBounds({ ...rect, y: Math.min(rect.y, wa.y + wa.height - height), height });
  }

  /// Free X/Y drag for both widgets. The coin collapses to its face first so the cursor stays on it. On release the
  /// rect snaps to near edges (rule A) and the placement is saved.
  ghostDrag(phase: 'start' | 'move' | 'end'): void {
    const ghost = this.ghost;
    if (!ghost || ghost.isDestroyed() || !this.ghostShape) return;
    if (phase === 'start') {
      let bounds = ghost.getBounds();
      if (this.ghostShape === 'coin' && this.coinFace) {
        bounds = { ...this.coinFace };
        ghost.setBounds(bounds);
      }
      this.drag = { cursor: screen.getCursorScreenPoint(), bounds };
      return;
    }
    if (phase === 'move') {
      if (!this.drag) return;
      const p = screen.getCursorScreenPoint();
      const dx = p.x - this.drag.cursor.x;
      const dy = p.y - this.drag.cursor.y;
      ghost.setPosition(Math.round(this.drag.bounds.x + dx), Math.round(this.drag.bounds.y + dy));
      return;
    }
    if (!this.drag) return;
    const p = ghost.getBounds();
    const wa = screen.getDisplayMatching(p).workArea;
    // Recompute the size: repairs DPI drift and caps the caption width to the display it landed on.
    const size = this.ghostShape === 'caption' ? this.captionSize(wa) : { width: COIN, height: COIN };
    const rect = snapRelease({ x: p.x, y: p.y, ...size }, wa, GHOST_MARGIN[this.ghostShape]);
    ghost.setBounds(rect);
    if (this.ghostShape === 'coin') this.coinFace = rect;
    this.persist(this.ghostShape, rect);
    this.drag = null;
  }

  /// Caption resize from its edges: height from the inner edge (the one facing the middle of the screen, outer edge
  /// stays put), width from the left / right edge. The final size goes to the renderer as a caption-height /
  /// caption-width event so it is saved to preferences; the position is saved here.
  ghostCaptionResize(
    phase: 'start' | 'move' | 'end',
    opts?: { edge?: 'height' | 'left' | 'right'; minHeight?: number },
  ): void {
    const ghost = this.ghost;
    if (!ghost || ghost.isDestroyed() || this.ghostShape !== 'caption') return;
    if (phase === 'start') {
      const b = ghost.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      const fixed = b.y + b.height / 2 >= wa.y + wa.height / 2 ? 'bottom' : 'top';
      // The renderer may only raise the height floor (its measured one-row layout), never lower it.
      const minHeight = clamp(Math.round(opts?.minHeight ?? CAPTION_MIN_H), CAPTION_MIN_H, CAPTION_MAX_H);
      this.resize = { cursor: screen.getCursorScreenPoint(), bounds: b, edge: opts?.edge ?? 'height', fixed, minHeight };
      return;
    }
    if (!this.resize) return;
    const { bounds: start, edge, fixed, minHeight } = this.resize;
    const wa = screen.getDisplayMatching(start).workArea;
    const cursor = screen.getCursorScreenPoint();
    let rect: Rectangle;
    if (edge === 'height') {
      const dy = cursor.y - this.resize.cursor.y;
      const max = Math.max(
        minHeight,
        Math.min(
          CAPTION_MAX_H,
          fixed === 'bottom' ? start.y + start.height - wa.y - CAPTION_MARGIN : wa.y + wa.height - start.y - CAPTION_MARGIN,
        ),
      );
      const height = clamp(Math.round(fixed === 'bottom' ? start.height - dy : start.height + dy), minHeight, max);
      const y = fixed === 'bottom' ? start.y + start.height - height : start.y;
      rect = { x: start.x, y, width: start.width, height };
    } else {
      const dx = cursor.x - this.resize.cursor.x;
      let width: number;
      let x: number;
      if (edge === 'left') {
        const right = start.x + start.width;
        const max = Math.min(CAPTION_MAX_W, right - wa.x);
        width = clamp(Math.round(start.width - dx), Math.min(CAPTION_MIN_W, max), max);
        x = right - width;
      } else {
        const max = Math.min(CAPTION_MAX_W, wa.x + wa.width - start.x);
        width = clamp(Math.round(start.width + dx), Math.min(CAPTION_MIN_W, max), max);
        x = start.x;
      }
      rect = { x, y: start.y, width, height: start.height };
    }
    ghost.setBounds(rect);
    if (phase === 'end') {
      this.resize = null;
      if (edge === 'height') {
        this.captionHeight = rect.height;
        this.opts.sendEvent({ type: 'caption-height', height: rect.height });
      } else {
        this.captionWidth = rect.width;
        this.opts.sendEvent({ type: 'caption-width', width: rect.width });
      }
      this.persist('caption', rect);
    }
  }

  /// Forgets the saved position (Settings > Reset overlay position); a live ghost jumps back to its default spot.
  resetGhostPosition(): void {
    this.saved = {};
    writeGhostState(this.opts.userDataDir, null);
    const ghost = this.ghost;
    if (!ghost || ghost.isDestroyed() || !this.ghostShape) return;
    const rect = this.placeFromSaved(this.ghostShape);
    ghost.setBounds(rect);
    this.coinFace = this.ghostShape === 'coin' ? rect : null;
  }

  dispose(): void {
    screen.removeListener('display-removed', this.onDisplaysChanged);
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged);
    this.destroyGhost();
    this.destroyPanels();
  }

  private restore(): void {
    const win = this.opts.window;
    this.destroyGhost();
    const hadPanels = this.panelOn.copilot || this.panelOn.assistant;
    this.destroyPanels();
    if (hadPanels) this.notifyPanels();
    applyOnTop(win, false);
    win.setResizable(true);
    win.setMinimumSize(FULL_MIN_W, FULL_MIN_H);
    const snap = this.snapshot;
    if (snap) {
      this.guarded(() => win.setBounds(clampToWorkArea(snap.bounds)));
      if (snap.maximized) win.maximize();
    }
    win.show();
    win.focus();
    this.snapshot = null;
  }

  /// Programmatic bounds changes fire 'resized' too; ignore those for a short window so they are not mistaken for user drags.
  private guarded(fn: () => void): void {
    this.applying = true;
    fn();
    setTimeout(() => {
      this.applying = false;
    }, 400);
  }

  private onUserResize(): void {
    if (this.applying) return;
    const win = this.opts.window;
    if (win.isDestroyed()) return;
    if (this.current === 'square') {
      if (win.isMaximized()) this.opts.sendEvent({ type: 'expand' });
      return;
    }
    if (this.current !== 'strip') return;
    const b = win.getBounds();
    if (win.isMaximized() || b.width > STRIP_EXIT) {
      this.opts.sendEvent({ type: 'expand' });
    } else if (b.width > STRIP_MAX || b.width < STRIP_MIN) {
      const w = clamp(b.width, STRIP_MIN, STRIP_MAX);
      const right = b.x + b.width;
      this.guarded(() => win.setBounds({ ...b, x: right - w, width: w }));
      this.opts.sendEvent({ type: 'strip-width', width: w });
    } else {
      this.opts.sendEvent({ type: 'strip-width', width: b.width });
    }
  }

  /// Primary display first, then the rest, deduped by id.
  private displays(): GhostDisplay[] {
    const out: GhostDisplay[] = [];
    for (const d of [screen.getPrimaryDisplay(), ...screen.getAllDisplays()]) {
      if (!out.some((o) => o.id === d.id)) out.push({ id: d.id, workArea: d.workArea });
    }
    return out;
  }

  private captionSize(wa: Rectangle): { width: number; height: number } {
    return {
      width: Math.round(Math.min(this.captionWidth, wa.width - 2 * CAPTION_MARGIN)),
      height: Math.round(Math.min(this.captionHeight, wa.height - 2 * CAPTION_MARGIN)),
    };
  }

  private sizeFor(shape: GhostShape, wa: Rectangle): { width: number; height: number } {
    return shape === 'caption' ? this.captionSize(wa) : { width: COIN, height: COIN };
  }

  /// Saved placement on its display (an unplugged display falls back to the one under the main window), else the default spot.
  private placeFromSaved(shape: GhostShape): Rectangle {
    const p = this.saved[shape];
    const fallback = this.snapshot?.bounds ?? (this.opts.window.isDestroyed() ? null : this.opts.window.getBounds());
    const d = resolveGhostDisplay(p, this.displays(), fallback);
    const size = this.sizeFor(shape, d.workArea);
    return p ? rectFromPlacement(p, size, d.workArea) : defaultGhostRect(shape, size, d.workArea);
  }

  private persist(shape: GhostShape, rect: Rectangle): void {
    const display = screen.getDisplayMatching(rect);
    this.saved = { ...this.saved, [shape]: placementFromRect(rect, { id: display.id, workArea: display.workArea }) };
    writeGhostState(this.opts.userDataDir, this.saved);
  }

  /// A display was removed or changed resolution: pull the ghost back inside its work area. Not persisted, so the
  /// saved placement still applies once the display returns. A hovered coin collapses; the renderer re-expands it.
  private reclampGhost(): void {
    const ghost = this.ghost;
    if (!ghost || ghost.isDestroyed() || !this.ghostShape) return;
    const b = ghost.getBounds();
    if (this.ghostShape === 'caption') {
      const wa = screen.getDisplayMatching(b).workArea;
      ghost.setBounds(clampRectInto({ ...b, ...this.captionSize(wa) }, wa));
      return;
    }
    const face = this.coinFace ?? b;
    const wa = screen.getDisplayMatching(face).workArea;
    this.coinFace = clampRectInto({ ...face, width: COIN, height: COIN }, wa);
    ghost.setBounds(this.coinFace);
  }

  private ghostUrl(shape: GhostShape): string {
    const u = new URL(this.opts.appUrl);
    u.searchParams.set('ghost', shape);
    return u.toString();
  }

  private ensureGhost(shape: GhostShape): void {
    const bounds = this.placeFromSaved(shape);
    this.coinFace = shape === 'coin' ? bounds : null;
    if (!this.ghost || this.ghost.isDestroyed()) {
      const ghost = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        focusable: true,
        alwaysOnTop: true,
        title: 'August',
        webPreferences: {
          preload: this.opts.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          spellcheck: false,
          webgl: false,
          plugins: false,
          enableWebSQL: false,
          devTools: this.opts.devTools,
        },
      });
      this.ghost = ghost;
      applyOnTop(ghost, true);
      ghost.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      ghost.webContents.on('will-navigate', (e) => e.preventDefault());
      // showInactive: never steal focus from the call the user is in.
      ghost.once('ready-to-show', () => ghost.showInactive());
      ghost.on('closed', () => {
        if (this.ghost === ghost) {
          this.ghost = null;
          this.ghostShape = null;
        }
      });
      void ghost.loadURL(this.ghostUrl(shape));
    } else {
      this.ghost.setBounds(bounds);
    }
    if (shape === 'caption') this.ghost.setIgnoreMouseEvents(true, { forward: true });
    else this.ghost.setIgnoreMouseEvents(false);
    this.ghostShape = shape;
  }

  private panelVisible(kind: PanelKind): boolean {
    const w = this.panels[kind];
    return this.panelOn[kind] && !!w && !w.isDestroyed();
  }

  private notifyPanels(): void {
    this.opts.onPanelsChange?.(this.panelState());
  }

  /// Bounds of the other compact surfaces a panel must not cover: the dock window (strip / square), the ghost
  /// widget (caption / coin) and the other visible panel.
  private panelObstacles(except: PanelKind): Rect[] {
    const out: Rect[] = [];
    const main = this.opts.window;
    if ((this.current === 'strip' || this.current === 'square') && !main.isDestroyed() && main.isVisible()) {
      out.push(main.getBounds());
    }
    if ((this.current === 'caption' || this.current === 'coin') && this.ghost && !this.ghost.isDestroyed()) {
      out.push(this.ghost.getBounds());
    }
    for (const k of PANEL_KINDS) {
      const w = this.panels[k];
      if (k !== except && w && !w.isDestroyed() && this.panelOn[k]) out.push(w.getBounds());
    }
    return out;
  }

  /// The dock / ghost window the default panel spots are laid out around.
  private panelAnchor(): Rectangle | null {
    const main = this.opts.window;
    if ((this.current === 'strip' || this.current === 'square') && !main.isDestroyed()) return main.getBounds();
    if (this.ghost && !this.ghost.isDestroyed()) return this.ghost.getBounds();
    return main.isDestroyed() ? null : (this.snapshot?.bounds ?? main.getBounds());
  }

  /// Default spot: left of the dock (assistant at the top of the work area, copilot below it); above the caption / coin.
  private defaultPanelRect(kind: PanelKind): Rect {
    const anchor = this.panelAnchor();
    const wa = (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea;
    const a = PANEL_DEFAULT.assistant;
    const c = PANEL_DEFAULT.copilot;
    const ghosted = this.current === 'caption' || this.current === 'coin';
    const assistant: Rect = ghosted
      ? {
          x: anchor ? anchor.x : wa.x + wa.width - a.width,
          y: (anchor ? anchor.y : wa.y + wa.height) - PANEL_GAP - a.height,
          width: a.width,
          height: a.height,
        }
      : { x: (anchor ? anchor.x : wa.x + wa.width) - PANEL_GAP - a.width, y: wa.y, width: a.width, height: a.height };
    if (kind === 'assistant') return clampInto(assistant, wa);
    const copilot: Rect = ghosted
      ? { x: assistant.x - PANEL_GAP - c.width, y: assistant.y, width: c.width, height: c.height }
      : { x: assistant.x, y: assistant.y + assistant.height + PANEL_GAP, width: c.width, height: c.height };
    return clampInto(copilot, wa);
  }

  /// Saved bounds (clamped into the display they are on) or the default spot, moved off any overlapped window.
  private placePanel(kind: PanelKind, preferred?: Rect): Rect {
    let r: Rect = preferred ?? this.savedPanels[kind] ?? this.defaultPanelRect(kind);
    const min = PANEL_MIN[kind];
    r = { ...r, width: Math.max(min.width, r.width), height: Math.max(min.height, r.height) };
    const wa = screen.getDisplayMatching(r).workArea;
    r = clampInto(r, wa);
    return resolveOverlap(r, this.panelObstacles(kind), wa);
  }

  private createPanel(kind: PanelKind): void {
    const bounds = this.placePanel(kind);
    const min = PANEL_MIN[kind];
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: false, // Windows cannot resize a transparent window
      backgroundColor: '#0a110d',
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      minWidth: min.width,
      minHeight: min.height,
      title: 'August',
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
        webgl: false,
        plugins: false,
        enableWebSQL: false,
        devTools: this.opts.devTools,
      },
    });
    this.panels[kind] = win;
    applyOnTop(win, true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    // showInactive: never steal focus from the call the user is in.
    win.once('ready-to-show', () => {
      if (this.panels[kind] === win && this.panelOn[kind]) win.showInactive();
    });
    const settle = (): void => this.schedulePanelSettle(kind);
    win.on('moved', settle);
    win.on('resized', settle);
    win.on('closed', () => {
      if (this.panels[kind] === win) {
        delete this.panels[kind];
        this.panelOn[kind] = false;
        this.notifyPanels();
      }
    });
    const u = new URL(this.opts.appUrl);
    u.searchParams.set('panel', kind);
    void win.loadURL(u.toString());
  }

  /// 'moved' fires continuously while dragging on macOS: settle once the window has been still for a moment.
  private schedulePanelSettle(kind: PanelKind): void {
    if (this.applying) return;
    const prev = this.panelTimers[kind];
    if (prev) clearTimeout(prev);
    this.panelTimers[kind] = setTimeout(() => {
      delete this.panelTimers[kind];
      this.settlePanel(kind);
    }, PANEL_SETTLE_MS);
  }

  /// After a user move / resize: snap to near edges, move off any overlapped window, save the bounds.
  private settlePanel(kind: PanelKind): void {
    const win = this.panels[kind];
    if (!win || win.isDestroyed() || this.applying) return;
    const cur = win.getBounds();
    const wa = screen.getDisplayMatching(cur).workArea;
    const others = this.panelObstacles(kind);
    let r = snapRect(cur, others, wa);
    if (others.some((o) => rectsOverlap(r, o))) r = resolveOverlap(r, others, wa);
    if (r.x !== cur.x || r.y !== cur.y || r.width !== cur.width || r.height !== cur.height) {
      this.guarded(() => win.setBounds(r));
    }
    this.savedPanels = { ...this.savedPanels, [kind]: r };
    writePanelState(this.opts.userDataDir, this.savedPanels);
  }

  /// The dock / ghost changed shape: move visible panels off whatever now overlaps them. Not persisted.
  private relayoutPanels(): void {
    for (const kind of PANEL_KINDS) {
      const win = this.panels[kind];
      if (!win || win.isDestroyed() || !this.panelOn[kind]) continue;
      const cur = win.getBounds();
      const r = this.placePanel(kind, cur);
      if (r.x !== cur.x || r.y !== cur.y || r.width !== cur.width || r.height !== cur.height) {
        this.guarded(() => win.setBounds(r));
      }
    }
  }

  /// A display was removed or changed resolution: pull the panels back inside their work area. Not persisted.
  private reclampPanels(): void {
    for (const kind of PANEL_KINDS) {
      const win = this.panels[kind];
      if (!win || win.isDestroyed()) continue;
      const cur = win.getBounds();
      const r = clampInto(cur, screen.getDisplayMatching(cur).workArea);
      if (r.x !== cur.x || r.y !== cur.y || r.width !== cur.width || r.height !== cur.height) {
        this.guarded(() => win.setBounds(r));
      }
    }
  }

  private destroyPanels(): void {
    for (const kind of PANEL_KINDS) {
      const timer = this.panelTimers[kind];
      if (timer) clearTimeout(timer);
      delete this.panelTimers[kind];
      const win = this.panels[kind];
      delete this.panels[kind];
      this.panelOn[kind] = false;
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  private destroyGhost(): void {
    if (this.ghost && !this.ghost.isDestroyed()) this.ghost.destroy();
    this.ghost = null;
    this.ghostShape = null;
    this.coinFace = null;
    this.drag = null;
    this.resize = null;
  }
}
