import React, { useEffect, useRef } from 'react';

export type OverlayId = 'sessions' | 'controls';

interface OverlayLayerProps {
  open: OverlayId | null;
  onOpen: (id: OverlayId) => void;
  onToggle: (id: OverlayId) => void;
  onClose: () => void;
  sessions: React.ReactNode;
  controls: React.ReactNode;
}

const EDGE_HOVER_DELAY_MS = 200;

const OverlayLayer: React.FC<OverlayLayerProps> = ({ open, onOpen, onToggle, onClose, sessions, controls }) => {
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHover = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  // Closing an overlay re-shows the edge zones under a cursor that may still rest on the edge;
  // ignore that re-entry until the cursor leaves the zone, or the close settles with no zone hovered.
  const suppressHoverRef = useRef(false);
  const leftEdgeRef = useRef<HTMLDivElement>(null);
  const rightEdgeRef = useRef<HTMLDivElement>(null);

  const startHover = (id: OverlayId) => {
    if (open || suppressHoverRef.current) return;
    clearHover();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      onOpen(id);
    }, EDGE_HOVER_DELAY_MS);
  };

  const endHover = () => {
    clearHover();
    suppressHoverRef.current = false;
  };

  useEffect(() => {
    if (open) return;
    suppressHoverRef.current = true;
    const t = setTimeout(() => {
      const edgeHovered = [leftEdgeRef, rightEdgeRef].some((r) => r.current?.matches(':hover'));
      if (!edgeHovered) suppressHoverRef.current = false;
    }, EDGE_HOVER_DELAY_MS * 2);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => clearHover, []);

  return (
    <>
      <div ref={leftEdgeRef} className="edge-trigger edge-trigger--left" aria-hidden="true" onMouseEnter={() => startHover('sessions')} onMouseLeave={endHover} />
      <div ref={rightEdgeRef} className="edge-trigger edge-trigger--right" aria-hidden="true" onMouseEnter={() => startHover('controls')} onMouseLeave={endHover} />
      <div className={`overlay-backdrop${open ? ' overlay-backdrop--visible' : ''}`} aria-hidden="true" onClick={onClose} />
      <aside
        className={`overlay-panel overlay-panel--left${open === 'sessions' ? ' overlay-panel--open' : ''}`}
        aria-label="Sessions"
        aria-hidden={open !== 'sessions'}
      >
        {sessions}
      </aside>
      <aside
        className={`overlay-panel overlay-panel--right${open === 'controls' ? ' overlay-panel--open' : ''}`}
        aria-label="Controls"
        aria-hidden={open !== 'controls'}
      >
        <div className="overlay-header">
          <span className="overlay-title">[ Controls ]</span>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="Close controls">×</button>
        </div>
        <div className="overlay-body">{controls}</div>
      </aside>
      <nav className="pin-toggles" aria-label="Panels">
        <button
          type="button"
          className={`pin-btn${open === 'sessions' ? ' pin-btn--active' : ''}`}
          aria-pressed={open === 'sessions'}
          title="Sessions (Ctrl+1)"
          onClick={() => onToggle('sessions')}
        >
          [ Sessions
        </button>
        <button
          type="button"
          className={`pin-btn${open === 'controls' ? ' pin-btn--active' : ''}`}
          aria-pressed={open === 'controls'}
          title="Controls (Ctrl+2)"
          onClick={() => onToggle('controls')}
        >
          Controls ]
        </button>
      </nav>
    </>
  );
};

export default OverlayLayer;
