/// Compact Mode (AUG-156): shrinks the main window into a right-edge strip or a corner square, or hides it
/// behind a transparent always-on-top "ghost" window (caption bar / coin). The renderer owns the compact state;
/// this controller only moves windows, remembers the full-size bounds and tells the renderer about user resizes.
import { BrowserWindow, screen, type Point, type Rectangle, type WebContents } from 'electron';

export type CompactShape = 'none' | 'strip' | 'square' | 'caption' | 'coin';
export interface CompactRequest {
  shape: CompactShape;
  stripWidth?: number;
  alwaysOnTop?: boolean;
}
export type CompactEvent = { type: 'expand' } | { type: 'toggle' } | { type: 'strip-width'; width: number };

type GhostShape = 'caption' | 'coin';
type CoinCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const STRIP_MIN = 280;
const STRIP_MAX = 520;
const STRIP_EXIT = 600;
const SQUARE = 180;
const SQUARE_MARGIN = 12;
const COIN = 56;
const COIN_MARGIN = 16;
const CAPTION_MAX_W = 760;
const CAPTION_H = 112;
const CAPTION_MARGIN = 24;
// Must equal createWindow's minWidth/minHeight in main.ts.
const FULL_MIN_W = 960;
const FULL_MIN_H = 600;

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
  onShapeChange(shape: CompactShape): void;
  sendEvent(event: CompactEvent): void;
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
  private captionEdge: 'top' | 'bottom' = 'bottom';
  private coinCorner: CoinCorner = 'bottom-right';
  private applying = false;
  private drag: { cursor: Point; bounds: Rectangle } | null = null;

  constructor(private readonly opts: CompactControllerOptions) {
    const win = opts.window;
    win.on('resized', () => this.onUserResize());
    win.on('maximize', () => this.onUserResize());
  }

  get shape(): CompactShape {
    return this.current;
  }

  isGhostSender(wc: WebContents): boolean {
    return this.ghost !== null && !this.ghost.isDestroyed() && this.ghost.webContents === wc;
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
          applyOnTop(win, false);
          win.hide();
          this.ensureGhost(req.shape, wa);
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
      return { ok: true, shape: this.current };
    } catch (err) {
      return { ok: false, shape: this.current, error: err instanceof Error ? err.message : String(err) };
    }
  }

  ghostSetIgnoreMouse(ignore: boolean): void {
    if (this.ghostShape !== 'caption' || !this.ghost || this.ghost.isDestroyed()) return;
    this.ghost.setIgnoreMouseEvents(ignore, { forward: true });
  }

  ghostResize(size: { width: number; height: number }): void {
    if (this.ghostShape !== 'coin' || !this.ghost || this.ghost.isDestroyed()) return;
    const width = clamp(Math.round(size.width), COIN, 320);
    const height = clamp(Math.round(size.height), COIN, 120);
    const wa = screen.getDisplayMatching(this.ghost.getBounds()).workArea;
    this.ghost.setBounds(this.ghostBounds('coin', wa, { width, height }));
  }

  ghostDrag(phase: 'start' | 'move' | 'end'): void {
    const ghost = this.ghost;
    if (!ghost || ghost.isDestroyed() || !this.ghostShape) return;
    if (phase === 'start') {
      this.drag = { cursor: screen.getCursorScreenPoint(), bounds: ghost.getBounds() };
      return;
    }
    if (phase === 'move') {
      if (!this.drag) return;
      const p = screen.getCursorScreenPoint();
      const dx = p.x - this.drag.cursor.x;
      const dy = p.y - this.drag.cursor.y;
      const wa = screen.getDisplayMatching(this.drag.bounds).workArea;
      if (this.ghostShape === 'caption') {
        const y = clamp(this.drag.bounds.y + dy, wa.y, wa.y + wa.height - this.drag.bounds.height);
        ghost.setPosition(Math.round(this.drag.bounds.x), Math.round(y));
      } else {
        ghost.setPosition(Math.round(this.drag.bounds.x + dx), Math.round(this.drag.bounds.y + dy));
      }
      return;
    }
    // end: snap to the nearest edge / corner of the display the ghost ended up on.
    const b = ghost.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    if (this.ghostShape === 'caption') {
      this.captionEdge = b.y + b.height / 2 < wa.y + wa.height / 2 ? 'top' : 'bottom';
      ghost.setBounds(this.ghostBounds('caption', wa));
    } else {
      const vertical = b.y + b.height / 2 < wa.y + wa.height / 2 ? 'top' : 'bottom';
      const horizontal = b.x + b.width / 2 < wa.x + wa.width / 2 ? 'left' : 'right';
      this.coinCorner = `${vertical}-${horizontal}` as CoinCorner;
      ghost.setBounds(this.ghostBounds('coin', wa, { width: b.width, height: b.height }));
    }
    this.drag = null;
  }

  dispose(): void {
    this.destroyGhost();
  }

  private restore(): void {
    const win = this.opts.window;
    this.destroyGhost();
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

  private ghostBounds(shape: GhostShape, wa: Rectangle, size?: { width: number; height: number }): Rectangle {
    if (shape === 'caption') {
      const width = Math.min(CAPTION_MAX_W, Math.round(wa.width * 0.8));
      const height = CAPTION_H;
      const x = wa.x + Math.round((wa.width - width) / 2);
      const y = this.captionEdge === 'top' ? wa.y + CAPTION_MARGIN : wa.y + wa.height - height - CAPTION_MARGIN;
      return { x, y, width, height };
    }
    const width = size?.width ?? COIN;
    const height = size?.height ?? COIN;
    const x = this.coinCorner.endsWith('right') ? wa.x + wa.width - width - COIN_MARGIN : wa.x + COIN_MARGIN;
    const y = this.coinCorner.startsWith('bottom') ? wa.y + wa.height - height - COIN_MARGIN : wa.y + COIN_MARGIN;
    return { x, y, width, height };
  }

  private ghostUrl(shape: GhostShape): string {
    const u = new URL(this.opts.appUrl);
    u.searchParams.set('ghost', shape);
    return u.toString();
  }

  private ensureGhost(shape: GhostShape, wa: Rectangle): void {
    const bounds = this.ghostBounds(shape, wa);
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

  private destroyGhost(): void {
    if (this.ghost && !this.ghost.isDestroyed()) this.ghost.destroy();
    this.ghost = null;
    this.ghostShape = null;
    this.drag = null;
  }
}
