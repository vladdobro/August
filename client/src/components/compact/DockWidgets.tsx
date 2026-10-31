import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CompactActions, CompactSnapshot } from '../../services/compactStore';
import { formatClock } from '../../services/compact';
import { statusTag } from './ghostProtocol';
import ActionItemsPanel from '../ActionItemsPanel';

interface DockProps {
  snap: CompactSnapshot;
  actions: CompactActions | null;
  onExpand: () => void;
}

interface EndConfirmProps {
  onYes: () => void;
  onNo: () => void;
}

const EndConfirm: React.FC<EndConfirmProps> = ({ onYes, onNo }) => (
  <div className="compact-confirm" role="alertdialog" aria-label="End recording?">
    <span className="compact-confirm-text">END RECORDING?</span>
    <div className="compact-confirm-actions">
      <button type="button" className="compact-btn compact-btn--end-fill" onClick={onYes} autoFocus>[ YES ]</button>
      <button type="button" className="compact-btn" onClick={onNo}>[ NO ]</button>
    </div>
  </div>
);

export const DockStrip: React.FC<DockProps> = ({ snap, actions, onExpand }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    followRef.current = follow;
    if (follow && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [snap.lines, follow]);

  // AUG-169: the action-items block grows and shrinks the transcript area; keep the teleprompter pinned to the latest line.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  const jump = () => {
    setFollow(true);
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  };

  const tag = statusTag(snap.liveStatus, snap.live);
  const paused = snap.liveStatus === 'paused';
  const interrupted = snap.liveStatus === 'interrupted';
  const inactive = !snap.live || interrupted || snap.liveStatus === 'stopped';

  const handleEnd = () => {
    if (snap.skipStopConfirmation) actions?.end();
    else setConfirming(true);
  };

  return (
    <div className={`compact-strip${interrupted ? ' compact-strip--interrupted' : ''}`}>
      <div className="compact-strip-top">
        <div
          className="compact-strip-head"
          onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) onExpand(); }}
        >
          <span className={`compact-rec${paused ? ' compact-rec--paused' : ''}`} aria-hidden="true" />
          <span className={`compact-timer${paused ? ' compact-timer--paused' : ''}`}>{formatClock(snap.elapsedSeconds)}</span>
          <span className={`compact-tag compact-tag--${tag.tone}`}>{tag.label}</span>
          <span className="compact-spacer" />
          <button type="button" className="compact-btn compact-btn--icon" onClick={onExpand} title="Expand August (Esc)" aria-label="Expand August">[ ⤢ ]</button>
        </div>
        <div className="compact-strip-tools">
          <button type="button" className="compact-btn" onClick={() => actions?.copyAll()} disabled={snap.lines.length === 0}>[ COPY ALL ]</button>
          <button type="button" className="compact-btn compact-btn--danger-outline" onClick={() => actions?.stopLive()} disabled={!snap.live}>[ STOP LIVE ]</button>
        </div>
      </div>

      {interrupted && (
        <div className="compact-strip-alert compact-strip-alert--error">
          <span>INTERRUPTED</span>
          <span className="compact-spacer" />
          <button type="button" className="compact-btn" onClick={() => actions?.retryLive()}>[ RETRY ]</button>
          <button type="button" className="compact-btn" onClick={onExpand}>[ OPEN ]</button>
        </div>
      )}
      {snap.captureLost && (
        <div className="compact-strip-alert compact-strip-alert--error">
          <span>CAPTURE LOST</span>
          <span className="compact-spacer" />
          <button type="button" className="compact-btn compact-btn--accent" onClick={onExpand}>[ OPEN AUGUST ]</button>
        </div>
      )}

      <div className="compact-strip-bodywrap">
        <div className="compact-strip-body" ref={bodyRef} onScroll={onScroll}>
          {snap.lines.length === 0 && <div className="compact-strip-empty">Waiting for speech…</div>}
          {snap.lines.map((line, i) => (
            <div key={i} className={`compact-line compact-line--${line.speaker.toLowerCase()}`}>{line.text}</div>
          ))}
        </div>
        {!follow && (
          <button type="button" className="compact-jump" onClick={jump} aria-label="Jump to latest">↓ LIVE</button>
        )}
      </div>

      {snap.live && (
        <div className="compact-strip-actions">
          <ActionItemsPanel
            variant="compact"
            items={snap.actionItems}
            participants={snap.participants}
            enabled={snap.actionEnabled}
            onAdd={(t, o) => actions?.addActionItem(t, o)}
            onEdit={(id, p) => actions?.editActionItem(id, p)}
            onDelete={(id) => actions?.deleteActionItem(id)}
          />
        </div>
      )}

      <div className="compact-strip-foot">
        <button
          type="button"
          className="compact-btn compact-btn--pause"
          onClick={() => (paused ? actions?.resumeLive() : actions?.pauseLive())}
          disabled={inactive}
        >
          {paused ? '[ RESUME ]' : '[ PAUSE ]'}
        </button>
        <button type="button" className="compact-btn compact-btn--end-fill" onClick={handleEnd}>[ END ]</button>
      </div>

      {confirming && (
        <EndConfirm onYes={() => { setConfirming(false); actions?.end(); }} onNo={() => setConfirming(false)} />
      )}
    </div>
  );
};

interface SquareProps extends DockProps {
  showCount: boolean;
  onShowTranscript: () => void;
}

export const DockSquare: React.FC<SquareProps> = ({ snap, actions, onExpand, showCount, onShowTranscript }) => {
  const [confirming, setConfirming] = useState(false);
  const paused = snap.liveStatus === 'paused';
  const interrupted = snap.liveStatus === 'interrupted';
  const lost = snap.captureLost;

  const tagLabel = lost ? 'LOST' : paused ? 'PAUSED' : snap.dualTrack ? 'MIC + SYS' : 'MIC';
  const tagTone = lost ? 'error' : paused ? 'pause' : 'idle';

  const handleStop = () => {
    if (snap.skipStopConfirmation) actions?.end();
    else setConfirming(true);
  };

  return (
    <div className="compact-square">
      <div className="compact-square-top">
        <span className={`compact-rec${paused ? ' compact-rec--paused' : ''}`} aria-hidden="true" />
        <span className={`compact-tag compact-tag--${tagTone}`}>{tagLabel}</span>
        {showCount && (
          <button type="button" className="compact-btn compact-btn--count" onClick={onShowTranscript} title="Show the live transcript">▤ {snap.lines.length}</button>
        )}
        <span className="compact-spacer" />
        <button type="button" className="compact-btn compact-btn--icon" onClick={onExpand} title="Expand August (Esc)" aria-label="Expand August">[ ⤢ ]</button>
      </div>

      <div className="compact-square-mid">
        {lost ? (
          <span className="compact-square-lost">CAPTURE LOST</span>
        ) : (
          <span className={`compact-square-timer${paused ? ' compact-timer--paused' : ''}`}>{formatClock(snap.elapsedSeconds)}</span>
        )}
        {interrupted && !lost && (
          <button type="button" className="compact-btn compact-btn--small" onClick={() => actions?.retryLive()}>[ RETRY ]</button>
        )}
      </div>

      <div className="compact-bars" aria-hidden="true">
        {snap.levels.map((level, i) => (
          <i key={i} style={{ height: paused || lost ? '10%' : `${Math.round((0.1 + Math.min(1, level) * 0.9) * 100)}%` }} />
        ))}
      </div>

      {lost ? (
        <button type="button" className="compact-square-bottom compact-square-bottom--open" onClick={onExpand}>[ OPEN AUGUST ]</button>
      ) : (
        <button type="button" className="compact-square-bottom compact-square-bottom--stop" onClick={handleStop}>[ STOP ]</button>
      )}

      {confirming && (
        <EndConfirm onYes={() => { setConfirming(false); actions?.end(); }} onNo={() => setConfirming(false)} />
      )}
    </div>
  );
};
