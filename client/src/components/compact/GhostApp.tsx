import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatClock } from '../../services/compact';
import ActionItemsPanel from '../ActionItemsPanel';
import { MicGlyph, useCtxBadge } from './DockWidgets';
import HoldToStopButton from '../HoldToStopButton';
import { GHOST_CHANNEL, statusTag, type GhostAction, type GhostCommand, type GhostMessage, type GhostState, type GhostWidget } from './ghostProtocol';

type Send = (command: GhostCommand) => void;
type SendAction = (action: GhostAction) => void;

interface GhostViewProps {
  state: GhostState;
  send: Send;
}

interface GhostCaptionProps extends GhostViewProps {
  sendAction: SendAction;
}

const COIN_SIZE = 56;
const COIN_EXPANDED_WIDTH = 372; // AUG-182: room for END MEETING

/// Window-level pointer helpers: ignore-mouse toggling and cursor-driven dragging are driven from the main process.
function setIgnoreMouse(ignore: boolean): void {
  window.august?.ghostSetIgnoreMouse?.(ignore);
}

/// AUG-182: "live text off" glyph — three text lines with a slash.
const LiveTextOffGlyph: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M4 6h16M4 12h16M4 18h10M3 3l18 18" />
  </svg>
);

const GhostCaption: React.FC<GhostCaptionProps> = ({ state, send, sendAction }) => {
  const [hovered, setHovered] = useState(false);
  const [leftHover, setLeftHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [edgeHover, setEdgeHover] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [actionsHover, setActionsHover] = useState(false);
  const [actionsFocus, setActionsFocus] = useState(false);
  const [widthResizing, setWidthResizing] = useState<'left' | 'right' | null>(null);
  const [widthHover, setWidthHover] = useState(false);
  const [square, setSquare] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false); // AUG-188
  const [tbarHover, setTbarHover] = useState(false); // AUG-188
  const linesRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef({ rect: 0, sq: 0 });

  const paused = state.liveStatus === 'paused';
  const interrupted = state.liveStatus === 'interrupted';
  const done = state.phase === 'done';
  const lost = state.captureLost;
  const alert = interrupted || lost || done;
  const tag = statusTag(state.liveStatus, state.live);
  const interactive = alert || leftHover || dragging || edgeHover || resizing || widthHover || widthResizing !== null || actionsHover || actionsFocus || tbarHover || clearConfirm;
  // The resize handle sits on the inner edge: top when the caption is docked at the bottom of the screen, and vice versa.
  // availTop (Chromium) is the display's top in virtual-screen coordinates, so a secondary monitor resolves correctly.
  const scr = window.screen as Screen & { availTop?: number };
  const dockedBottom = window.screenY + window.innerHeight / 2 >= (scr.availTop ?? 0) + scr.availHeight / 2;

  // AUG-188: the text toolbar and its confirm row disappear with Live and in the 72 px layout.
  useEffect(() => {
    if (!state.live) {
      setClearConfirm(false);
      setTbarHover(false);
    }
  }, [state.live]);
  useEffect(() => {
    if (square) setTbarHover(false);
  }, [square]);

  // Click-through unless something clickable is showing or hovered.
  useEffect(() => {
    setIgnoreMouse(!interactive);
  }, [interactive]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    window.august?.ghostDrag?.('start');
  };
  const onPointerMove = () => {
    if (dragging) window.august?.ghostDrag?.('move');
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    window.august?.ghostDrag?.('end');
  };

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
    window.august?.ghostCaptionResize?.('start', { edge: 'height', minHeight: fitRef.current.sq });
  };
  const onResizeMove = () => {
    if (resizing) window.august?.ghostCaptionResize?.('move', { edge: 'height' });
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setResizing(false);
    window.august?.ghostCaptionResize?.('end', { edge: 'height' });
  };

  // Width drag from the left / right edge (AUG-187); main keeps the opposite edge fixed.
  const onWidthDown = (side: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setWidthResizing(side);
    window.august?.ghostCaptionResize?.('start', { edge: side });
  };
  const onWidthMove = (side: 'left' | 'right') => () => {
    if (widthResizing === side) window.august?.ghostCaptionResize?.('move', { edge: side });
  };
  const endWidth = (side: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (widthResizing !== side) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setWidthResizing(null);
    window.august?.ghostCaptionResize?.('end', { edge: side });
  };

  // Tool layout thresholds are measured from the rendered layout (two rows of rectangles vs one row of squares),
  // never hard-coded. React rewrites className on render; the classes are restored synchronously here, so this is safe.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const left = leftRef.current;
    if (!root || !left) return;
    const had = root.classList.contains('ghost-caption--sq');
    const border = root.offsetHeight - root.clientHeight;
    left.classList.add('ghost-caption-left--measure');
    root.classList.remove('ghost-caption--sq');
    const rect = left.offsetHeight + border;
    root.classList.add('ghost-caption--sq');
    const sq = left.offsetHeight + border;
    root.classList.toggle('ghost-caption--sq', had);
    left.classList.remove('ghost-caption-left--measure');
    fitRef.current = { rect, sq };
    setSquare(root.offsetHeight < rect);
  }, [state.live, state.micMuted, state.mutedHint, interrupted, lost, done, paused]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setSquare(root.offsetHeight < fitRef.current.rect));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Teleprompter: the newest text is always in view. New or growing lines scroll smoothly; a height change snaps.
  useLayoutEffect(() => {
    const el = linesRef.current;
    if (!el) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, [state.lines, state.lineCount, state.captionFontSize]);
  useEffect(() => {
    const el = linesRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { el.scrollTop = el.scrollHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const showTools = (hovered || leftHover) && !alert;
  const lines = state.lines;

  return (
    <div
      ref={rootRef}
      style={{ '--ghost-bg': `rgba(6, 11, 8, ${state.captionOpacity / 100})`, '--ghost-line-size': `${state.captionFontSize}px` } as React.CSSProperties}
      className={`ghost-caption${interrupted || lost ? ' ghost-caption--error' : ''}${done ? ' ghost-caption--done' : ''}${square ? ' ghost-caption--sq' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={done ? () => send('expand') : undefined}
    >
      {!done && (
        <div
          className={`ghost-caption-resize ghost-caption-resize--${dockedBottom ? 'top' : 'bottom'}${resizing ? ' ghost-caption-resize--active' : ''}`}
          onMouseEnter={() => setEdgeHover(true)}
          onMouseLeave={() => setEdgeHover(false)}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          title="Drag to resize"
          aria-hidden="true"
        />
      )}
      {!done && (['left', 'right'] as const).map((side) => (
        <div
          key={side}
          className={`ghost-caption-wresize ghost-caption-wresize--${side}${widthResizing === side ? ' ghost-caption-wresize--active' : ''}`}
          onMouseEnter={() => setWidthHover(true)}
          onMouseLeave={() => setWidthHover(false)}
          onPointerDown={onWidthDown(side)}
          onPointerMove={onWidthMove(side)}
          onPointerUp={endWidth(side)}
          onPointerCancel={endWidth(side)}
          title="Drag to resize"
          aria-hidden="true"
        />
      ))}
      <div
        ref={leftRef}
        className="ghost-caption-left"
        onMouseEnter={() => setLeftHover(true)}
        onMouseLeave={() => setLeftHover(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {done ? (
          <>
            <span className="ghost-timer">DONE · {formatClock(state.elapsedSeconds)}</span>
            <button type="button" className="ghost-btn ghost-btn--accent" onClick={() => send('expand')}>[ OPEN ]</button>
          </>
        ) : (
          <>
            <div className="ghost-caption-id">
              <span className={`ghost-rec${paused ? ' ghost-rec--paused' : ''}`} aria-hidden="true" />
              <span className={`ghost-timer${paused ? ' ghost-timer--paused' : ''}`}>{formatClock(state.elapsedSeconds)}</span>
            </div>
            <span className={`ghost-tag ghost-tag--${lost ? 'error' : tag.tone}`}>{lost ? 'CAPTURE LOST' : tag.label}</span>
            {state.micMuted && !lost && <span className="ghost-tag ghost-tag--muted">{state.mutedHint ? "YOU'RE MUTED" : 'MIC OFF'}</span>}
            {interrupted && !lost && (
              <div className="ghost-caption-tools ghost-caption-tools--always">
                <button type="button" className="ghost-btn" onClick={() => send('retry')}>[ RETRY ]</button>
                <button type="button" className="ghost-btn" onClick={() => send('expand')}>[ OPEN ]</button>
              </div>
            )}
            {lost && (
              <div className="ghost-caption-tools ghost-caption-tools--always">
                <button type="button" className="ghost-btn ghost-btn--accent" onClick={() => send('expand')}>[ OPEN AUGUST ]</button>
              </div>
            )}
            {!alert && (
              <div className={`ghost-caption-tools ghost-caption-tools--grid${showTools ? ' ghost-caption-tools--shown' : ''}`}>
                <button type="button" className="ghost-btn" onClick={() => send('expand')} title="Expand August" aria-label="Expand August"><span className="ghost-br">[ </span>⤢<span className="ghost-br"> ]</span></button>
                <button type="button" className="ghost-btn" onClick={() => send('switch')} title="Switch to Ghost Coin" aria-label="Switch to Ghost Coin"><span className="ghost-br">[ </span>⇄<span className="ghost-br"> ]</span></button>
                {state.live && !interrupted && (
                  <button
                    type="button"
                    className="ghost-btn ghost-btn--pause"
                    onClick={() => send(paused ? 'resume' : 'pause')}
                    title={paused ? 'Resume' : 'Pause'}
                    aria-label={paused ? 'Resume' : 'Pause'}
                  >
                    <span className="ghost-br">[ </span>{paused ? '▶' : '⏸'}<span className="ghost-br"> ]</span>
                  </button>
                )}
                <button
                  type="button"
                  className={`ghost-btn ghost-btn--mute${state.micMuted ? ' ghost-btn--mute-on' : ''}`}
                  onClick={() => send(state.micMuted ? 'unmute' : 'mute')}
                  aria-pressed={state.micMuted}
                  aria-label={state.micMuted ? 'Unmute microphone' : 'Mute microphone'}
                  title="Mute in August's recording"
                >
                  <span className="ghost-br">[ </span><MicGlyph muted={state.micMuted} /><span className="ghost-br"> ]</span>
                </button>
                {state.live ? (
                  <HoldToStopButton className="ghost-btn ghost-btn--end" onComplete={() => send('stop-live')} title="Hold 1.5 s to stop live text. Recording continues." ariaLabel="Stop Live Text (hold 1.5 seconds)" hint="HOLD"><span className="ghost-br">[ </span><LiveTextOffGlyph /><span className="ghost-br"> ]</span></HoldToStopButton>
                ) : (
                  <button type="button" className="ghost-btn ghost-btn--solid" onClick={() => send('start-live')} title="Start live text again. Recording continues." aria-label="Start live text"><span className="ghost-br">[ </span>▶&#xFE0E;<span className="ghost-br"> ]</span></button>
                )}
                <HoldToStopButton className="ghost-btn ghost-btn--end" onComplete={() => send('end')} title="Hold 1.5 s to end the meeting" ariaLabel="End Meeting (hold 1.5 seconds)" hint="HOLD"><span className="ghost-br">[ </span>■<span className="ghost-br"> ]</span></HoldToStopButton>
              </div>
            )}
          </>
        )}
      </div>

      <div className="ghost-caption-mid">
        {!done && state.live && (clearConfirm ? (
          <div className="ghost-caption-tbar ghost-caption-tbar--confirm" role="alertdialog" aria-label="Clear transcript?" onMouseEnter={() => setTbarHover(true)} onMouseLeave={() => setTbarHover(false)}>
            <span>CLEAR TRANSCRIPT?</span>
            <button type="button" className="ghost-btn ghost-btn--danger-fill" onClick={() => { setClearConfirm(false); send('clear'); }} autoFocus>[ YES ]</button>
            <button type="button" className="ghost-btn" onClick={() => setClearConfirm(false)}>[ NO ]</button>
          </div>
        ) : (
          <div className={`ghost-caption-tbar${hovered && !alert ? ' ghost-caption-tbar--shown' : ''}`} onMouseEnter={() => setTbarHover(true)} onMouseLeave={() => setTbarHover(false)}>
            <span className="ghost-tbar-group">
              <button type="button" className="ghost-btn" onClick={() => send('copy-all')} disabled={state.lineCount === 0}>[ COPY ALL ]</button>
              <button type="button" className="ghost-btn ghost-btn--accent" onClick={() => send('copy-clear')} disabled={state.lineCount === 0}>[ COPY &amp; CLEAR ]</button>
              <button type="button" className="ghost-btn ghost-btn--end" onClick={() => { if (state.skipClearConfirmation) send('clear'); else setClearConfirm(true); }} disabled={state.lineCount === 0}>[ CLEAR ]</button>
            </span>
            <span className="ghost-tbar-sep" aria-hidden="true" />
            <span className="ghost-tbar-group">
              <button type="button" className="ghost-btn" onClick={() => send('font-down')} disabled={state.captionFontSize <= 12} title="Smaller text">[ A− ]</button>
              <span className="ghost-tbar-value">{state.captionFontSize}</span>
              <button type="button" className="ghost-btn" onClick={() => send('font-up')} disabled={state.captionFontSize >= 22} title="Larger text">[ A+ ]</button>
            </span>
            <span className="ghost-tbar-sep" aria-hidden="true" />
            <button type="button" className="ghost-btn" onClick={() => send('opacity-next')} title="Background opacity (text stays 100%)">[ ◐ {state.captionOpacity}% ]</button>
          </div>
        ))}
        <div className="ghost-caption-lines" ref={linesRef}>
          {lines.length === 0 && !done && <div className="ghost-line ghost-line--empty">{state.live ? 'Waiting for speech…' : 'Live text is off'}</div>}
          {lines.map((line, i) => (
            <div
              key={`${state.lineCount - lines.length + i}`}
              className={`ghost-line ghost-line--${line.kind === 'gap' ? 'gap' : line.speaker.toLowerCase()}${i < lines.length - 1 ? ' ghost-line--old' : ''}${i < lines.length - 2 ? ' ghost-line--older' : ''}`}
            >
              {line.text}
            </div>
          ))}
        </div>
      </div>

      {(state.live || state.meeting) && !done && (
        <div
          className="ghost-caption-actions"
          onMouseEnter={() => setActionsHover(true)}
          onMouseLeave={() => setActionsHover(false)}
          onFocus={() => setActionsFocus(true)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setActionsFocus(false); }}
        >
          <ActionItemsPanel
            variant="compact"
            items={state.actionItems}
            participants={state.participants}
            enabled={state.actionEnabled}
            offReason={state.actionOffReason}
            onAdd={(text, owner) => sendAction({ kind: 'add', text, owner })}
            onEdit={(id, patch) => sendAction({ kind: 'edit', id, patch })}
            onDelete={(id) => sendAction({ kind: 'delete', id })}
            onSendToPraxis={(ids) => sendAction({ kind: 'praxis', ids })}
          />
        </div>
      )}
    </div>
  );
};

const GhostCoin: React.FC<GhostViewProps> = ({ state, send }) => {
  const [hovered, setHovered] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [faceSide, setFaceSide] = useState<'left' | 'right'>('right');
  const dragRef = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const movedRef = useRef(false);
  const ctx = useCtxBadge(); // AUG-199

  const paused = state.liveStatus === 'paused';
  const done = state.phase === 'done';
  const lost = state.captureLost;
  const expanded = (hovered || menu) && !dragActive;

  useEffect(() => {
    if (!expanded) {
      window.august?.ghostResize?.({ width: COIN_SIZE, height: COIN_SIZE });
      return;
    }
    // The window equals the face while collapsed. Same rule as coinExpandedRect in electron/src/ghostGeometry.ts:
    // grow toward the screen middle, flip when that side has no room. Main honors faceSide, so the face never moves
    // and the row direction always matches.
    const scr = window.screen as Screen & { availLeft?: number };
    const waX = scr.availLeft ?? 0;
    const waW = scr.availWidth;
    let right = window.screenX + COIN_SIZE / 2 > waX + waW / 2; // face on the right -> grow left
    const fitsLeftGrowth = window.screenX + COIN_SIZE - COIN_EXPANDED_WIDTH >= waX;
    const fitsRightGrowth = window.screenX + COIN_EXPANDED_WIDTH <= waX + waW;
    if (right && !fitsLeftGrowth && fitsRightGrowth) right = false;
    else if (!right && !fitsRightGrowth && fitsLeftGrowth) right = true;
    const side = right ? 'right' : 'left';
    setFaceSide(side);
    window.august?.ghostResize?.({ width: COIN_EXPANDED_WIDTH, height: COIN_SIZE, faceSide: side });
  }, [expanded]);

  const anchoredRight = faceSide === 'right';

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, active: false };
    movedRef.current = false;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
      d.active = true;
      setDragActive(true);
      movedRef.current = true;
      window.august?.ghostDrag?.('start');
      return;
    }
    window.august?.ghostDrag?.('move');
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragActive(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.active) {
      window.august?.ghostDrag?.('end');
      return;
    }
    if (done) send('expand');
    else if (state.showCount) send('switch');
  };

  const face = done ? 'DONE' : lost ? 'LOST' : null;

  return (
    <div
      className={`ghost-coin${lost ? ' ghost-coin--error' : ''}${state.micMuted ? ' ghost-coin--muted' : ''}${expanded ? ' ghost-coin--expanded' : ''}`}
      style={{ flexDirection: anchoredRight ? 'row-reverse' : 'row' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMenu(false); }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!done) {
          setMenu(true);
        }
      }}
    >
      <div
        className="ghost-coin-face"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {face ? (
          <span className={`ghost-coin-word${lost ? ' ghost-coin-word--error' : ''}`}>{face}</span>
        ) : (
          <>
            <span className="ghost-coin-top">
              <span className={`ghost-rec${paused ? ' ghost-rec--paused' : ''}`} aria-hidden="true" />
              {state.showCount && <span className="ghost-coin-count">▤ {state.lineCount}</span>}
            </span>
            <span className={`ghost-coin-time${paused ? ' ghost-timer--paused' : ''}`}>{formatClock(state.elapsedSeconds)}</span>
            {state.micMuted && <span className={`ghost-coin-muted${state.mutedHint ? ' ghost-coin-muted--hint' : ''}`}>MUTED</span>}
          </>
        )}
      </div>

      {expanded && (
      <div className="ghost-coin-actions">
          <>
            {ctx.count > 0 && !done && !lost && (
              <button type="button" className="ghost-btn ghost-btn--accent" onClick={ctx.show} title="Show Copilot in the full window">[ CTX {ctx.count} ]</button>
            )}
            {state.live && !done && !lost && (
              <button
                type="button"
                className="ghost-btn ghost-btn--pause"
                onClick={() => send(paused ? 'resume' : 'pause')}
              >
                {paused ? '[ RESUME ]' : '[ PAUSE ]'}
              </button>
            )}
            {!state.live && !done && !lost && (
              <button type="button" className="ghost-btn ghost-btn--solid" onClick={() => send('start-live')} title="Start live text again">[ ▶&#xFE0E; LIVE ]</button>
            )}
            {!done && !lost && (
              <button
                type="button"
                className={`ghost-btn ghost-btn--mute${state.micMuted ? ' ghost-btn--mute-on' : ''}`}
                onClick={() => send(state.micMuted ? 'unmute' : 'mute')}
              >
                {state.micMuted ? '[ UNMUTE ]' : '[ MUTE ]'}
              </button>
            )}
            {!done && !lost && <HoldToStopButton className="ghost-btn ghost-btn--end" onComplete={() => send('end')} title="Hold 1.5 s to end the meeting" ariaLabel="End Meeting (hold 1.5 seconds)" hint="[ HOLD ]">[ END MEETING ]</HoldToStopButton>}
            {(state.live || state.meeting) && !done && !lost && (
              <button type="button" className="ghost-btn" onClick={() => send('switch')} title="Switch to Ghost Caption" aria-label="Switch to Ghost Caption">[ ⇄ ]</button>
            )}
            <button type="button" className={`ghost-btn${lost || done ? ' ghost-btn--accent' : ''}`} onClick={() => send('expand')}>[ OPEN ]</button>
            </>
        </div>
      )}
    </div>
  );
};

const PLACEHOLDER = (widget: GhostWidget): GhostState => ({
  widget,
  phase: 'compact',
  recording: true,
  live: true,
  lines: [],
  lineCount: 0,
  showCount: false,
  liveStatus: 'connecting',
  captureLost: false,
  elapsedSeconds: 0,
  actionItems: [],
  participants: { me: '', them: '' },
  actionEnabled: null,
  actionOffReason: null,
  meeting: false,
  micMuted: false,
  mutedHint: false,
  skipClearConfirmation: false,
  captionFontSize: 14,
  captionOpacity: 78,
});

interface GhostAppProps {
  initialWidget: GhostWidget;
}

/// Renderer for the frameless ghost window (?ghost=caption|coin). State comes from the main window over BroadcastChannel.
const GhostApp: React.FC<GhostAppProps> = ({ initialWidget }) => {
  const [state, setState] = useState<GhostState | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const send = useCallback<Send>((command) => {
    channelRef.current?.postMessage({ type: 'command', command } satisfies GhostMessage);
  }, []);

  const sendAction = useCallback((action: GhostAction) => {
    channelRef.current?.postMessage({ type: 'action', action } satisfies GhostMessage);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('ghost-root');
    const channel = new BroadcastChannel(GHOST_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<GhostMessage>) => {
      if (event.data?.type === 'state') setState(event.data.state);
    };
    channel.postMessage({ type: 'hello' } satisfies GhostMessage);

    const onKey = (e: KeyboardEvent) => {
      // Escape inside an input cancels that edit instead of expanding August.
      if (e.key === 'Escape' && (e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
      if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyC')) {
        e.preventDefault();
        channel.postMessage({ type: 'command', command: 'expand' } satisfies GhostMessage);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      channel.close();
      channelRef.current = null;
      document.documentElement.classList.remove('ghost-root');
    };
  }, []);

  const current = state ?? PLACEHOLDER(initialWidget);
  return current.widget === 'ghost-coin'
    ? <GhostCoin state={current} send={send} />
    : <GhostCaption state={current} send={send} sendAction={sendAction} />;
};

export default GhostApp;
