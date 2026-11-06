import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CompactActions, CompactSnapshot } from '../../services/compactStore';
import { formatClock } from '../../services/compact';
import { statusTag } from './ghostProtocol';
import ActionItemsPanel from '../ActionItemsPanel';
import HoldToStopButton from '../HoldToStopButton';
import { useAssistantSnapshot } from './useAssistantSnapshot';
import './compactPanels.css';

/// AUG-199: which compact Copilot / Assistant windows are open (desktop shell only; main pushes changes).
function useCompactPanels(): { copilot: boolean; assistant: boolean } {
  const [state, setState] = useState({ copilot: false, assistant: false });
  useEffect(() => window.august?.onCompactPanels?.(setState), []);
  return state;
}

/// AUG-199: hint count for the `CTX n` badge, read from the assistant channel; clicking it opens COPILOT in the full window.
export function useCtxBadge(): { count: number; show: () => void } {
  const { snap, send } = useAssistantSnapshot();
  return { count: snap?.copilot.hintCount ?? 0, show: () => send({ kind: 'show-copilot' }) };
}

/// AUG-181: small mic glyph, slashed when muted.
export const MicGlyph: React.FC<{ muted: boolean }> = ({ muted }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="9" y="3" width="6" height="12" />
    <path d={muted ? 'M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18' : 'M5 11a7 7 0 0 0 14 0M12 18v3'} />
  </svg>
);

interface DockProps {
  snap: CompactSnapshot;
  actions: CompactActions | null;
  onExpand: () => void;
}

interface StripProps extends DockProps {
  onSwitch: () => void; // AUG-188
  onSendToPraxis: (ids: string[]) => void; // AUG-188
}

export const DockStrip: React.FC<StripProps> = ({ snap, actions, onExpand, onSwitch, onSendToPraxis }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const [clearConfirm, setClearConfirm] = useState(false);
  const panels = useCompactPanels();
  const canPanels = Boolean(window.august?.setCompactPanel);
  useEffect(() => { if (!snap.live) setClearConfirm(false); }, [snap.live]);
  const handleClear = () => { if (snap.skipClearConfirmation) actions?.clearLive(); else setClearConfirm(true); };

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
          {snap.micMuted && <span className="compact-tag compact-tag--muted">{snap.mutedHint ? "YOU'RE MUTED" : 'MIC OFF'}</span>}
          <span className="compact-spacer" />
          {canPanels && (snap.live ? ['copilot', 'assistant'] as const : ['assistant'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`compact-btn compact-btn--icon cp-panel-toggle${panels[kind] ? ' compact-btn--accent' : ''}`}
              onClick={() => window.august?.setCompactPanel?.(kind, !panels[kind])}
              aria-pressed={panels[kind]}
              aria-label={`${panels[kind] ? 'Hide' : 'Show'} ${kind === 'copilot' ? 'Copilot' : 'Assistant'} window`}
              title={`${panels[kind] ? 'Hide' : 'Show'} ${kind === 'copilot' ? 'Copilot' : 'Assistant'} window`}
            >
              {kind === 'copilot' ? '[ CP ]' : '[ AS ]'}
            </button>
          ))}
          <button type="button" className="compact-btn compact-btn--icon" onClick={onSwitch} title="Switch to Dock Square" aria-label="Switch to Dock Square">[ ⇄ ]</button>
          <button type="button" className="compact-btn compact-btn--icon" onClick={onExpand} title="Expand August (Esc)" aria-label="Expand August">[ ⤢ ]</button>
        </div>
        <div className="compact-strip-tools">
          <button type="button" className="compact-btn compact-btn--accent" onClick={() => actions?.copyAll()} disabled={snap.lines.length === 0}>[ COPY ALL ]</button>
          <button type="button" className="compact-btn compact-btn--accent" onClick={() => actions?.copyAndClear()} disabled={snap.lines.length === 0}>[ COPY &amp; CLEAR ]</button>
          <button type="button" className="compact-btn compact-btn--danger-outline" onClick={handleClear} disabled={snap.lines.length === 0}>[ CLEAR ]</button>
          {snap.live ? (
            <HoldToStopButton className="compact-btn compact-btn--danger-outline" onComplete={() => actions?.stopLive()} title="Hold 1.5 s to stop live text. Recording continues." ariaLabel="Stop Live Text (hold 1.5 seconds)" hint="[ HOLD ]">[ STOP LIVE TEXT ]</HoldToStopButton>
          ) : (
            <button type="button" className="compact-btn compact-btn--solid" onClick={() => actions?.startLive()} title="Start live text again. Recording continues.">[ ▶&#xFE0E; START LIVE TEXT ]</button>
          )}
        </div>
        {clearConfirm && (
          <div className="compact-strip-confirm" role="alertdialog" aria-label="Clear transcript?">
            <span>CLEAR TRANSCRIPT?</span>
            <span className="compact-spacer" />
            <button type="button" className="compact-btn compact-btn--end-fill" onClick={() => { setClearConfirm(false); actions?.clearLive(); }} autoFocus>[ YES ]</button>
            <button type="button" className="compact-btn" onClick={() => setClearConfirm(false)}>[ NO ]</button>
          </div>
        )}
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
          {snap.lines.length === 0 && <div className="compact-strip-empty">{snap.live ? 'Waiting for speech…' : 'Live text is off'}</div>}
          {snap.lines.map((line, i) => line.kind === 'gap' ? (
            <div key={i} className="compact-line compact-line--gap">{line.text}</div>
          ) : (
            <div key={i} className={`compact-line compact-line--${line.speaker.toLowerCase()}`}>{line.text}</div>
          ))}
        </div>
        {!follow && (
          <button type="button" className="compact-jump" onClick={jump} aria-label="Jump to latest">↓ LIVE</button>
        )}
      </div>

      {(snap.live || snap.meeting) && (
        <div className="compact-strip-actions">
          <ActionItemsPanel
            variant="compact"
            items={snap.actionItems}
            participants={snap.participants}
            enabled={snap.actionEnabled}
            offReason={snap.actionOffReason}
            onAdd={(t, o) => actions?.addActionItem(t, o)}
            onEdit={(id, p) => actions?.editActionItem(id, p)}
            onDelete={(id) => actions?.deleteActionItem(id)}
            onSendToPraxis={(ids) => onSendToPraxis(ids)}
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
        <button
          type="button"
          className={`compact-btn compact-btn--mute${snap.micMuted ? ' compact-btn--mute-on' : ''}`}
          onClick={() => actions?.setMicMuted(!snap.micMuted)}
          aria-pressed={snap.micMuted}
          title="Mute in August's recording"
        >
          {snap.micMuted ? '[ UNMUTE ]' : '[ MUTE ]'}
        </button>
        <HoldToStopButton className="compact-btn compact-btn--end-fill" onComplete={() => actions?.end()} title="Hold 1.5 s to end the meeting" ariaLabel="End Meeting (hold 1.5 seconds)" hint="[ HOLD ]">[ END MEETING ]</HoldToStopButton>
      </div>
    </div>
  );
};

interface SquareProps extends DockProps {
  onSwitch: () => void; // AUG-188
}

export const DockSquare: React.FC<SquareProps> = ({ snap, actions, onExpand, onSwitch }) => {
  const paused = snap.liveStatus === 'paused';
  const interrupted = snap.liveStatus === 'interrupted';
  const lost = snap.captureLost;
  const ctx = useCtxBadge();

  const tagLabel = lost ? 'LOST' : paused ? 'PAUSED' : snap.micMuted ? (snap.dualTrack ? 'SYS · MIC OFF' : 'MIC OFF') : (snap.dualTrack ? 'MIC + SYS' : 'MIC');
  const tagTone = lost ? 'error' : paused ? 'pause' : snap.micMuted ? 'muted' : 'idle';

  return (
    <div className="compact-square">
      <div className="compact-square-top">
        <span className={`compact-rec${paused ? ' compact-rec--paused' : ''}`} aria-hidden="true" />
        <span className={`compact-tag compact-tag--${tagTone} compact-square-tag`}>{tagLabel}</span>
        {!snap.live && snap.meeting && !lost && (
          <button type="button" className="compact-btn compact-btn--icon compact-square-icon" onClick={onSwitch} aria-label="Show action items — switch to Dock Strip" title="Show action items — switch to Dock Strip">⇄</button>
        )}
        {snap.live && !interrupted && !lost && (
          <button
            type="button"
            className={`compact-btn compact-btn--icon compact-square-icon${paused ? ' compact-btn--pause' : ''}`}
            onClick={() => (paused ? actions?.resumeLive() : actions?.pauseLive())}
            aria-label={paused ? 'Resume live text' : 'Pause live text'}
            title={paused ? 'Resume live text' : 'Pause live text'}
          >
            {paused ? '▶︎' : '❚❚'}
          </button>
        )}
        <button
          type="button"
          className={`compact-btn compact-btn--icon compact-square-icon compact-btn--mute${snap.micMuted ? ' compact-btn--mute-on' : ''}`}
          onClick={() => actions?.setMicMuted(!snap.micMuted)}
          aria-pressed={snap.micMuted}
          aria-label={snap.micMuted ? 'Unmute microphone' : 'Mute microphone'}
          title="Mute in August's recording"
        >
          <MicGlyph muted={snap.micMuted} />
        </button>
        <button type="button" className="compact-btn compact-btn--icon compact-square-icon" onClick={onExpand} title="Expand August (Esc)" aria-label="Expand August">⤢</button>
      </div>

      <div className="compact-square-mid">
        {lost ? (
          <span className="compact-square-lost">CAPTURE LOST</span>
        ) : (
          <span className={`compact-square-timer${paused ? ' compact-timer--paused' : ''}`}>{formatClock(snap.elapsedSeconds)}</span>
        )}
        {!lost && (snap.live ? (
          <button type="button" className="compact-btn compact-btn--count compact-btn--small" onClick={onSwitch} title="Show the transcript here — switch to Dock Strip">▤ {snap.lines.length} ⇄</button>
        ) : (
          <button type="button" className="compact-btn compact-btn--solid compact-btn--small" onClick={() => actions?.startLive()} title="Start live text again. Recording continues.">▶&#xFE0E; LIVE</button>
        ))}
        {ctx.count > 0 && !lost && (
          <button type="button" className="cp-ctx" onClick={ctx.show} aria-label={`${ctx.count} hint, show Copilot in the full window`}>CTX {ctx.count}</button>
        )}
        {snap.mutedHint && !lost && <span className="compact-tag compact-tag--muted">YOU'RE MUTED</span>}
        {interrupted && !lost && (
          <button type="button" className="compact-btn compact-btn--small" onClick={() => actions?.retryLive()}>[ RETRY ]</button>
        )}
      </div>

      <div className="compact-bars" aria-hidden="true">
        {snap.levels.map((level, i) => (
          <i key={i} style={{ height: paused || lost || (snap.micMuted && !snap.dualTrack) ? '10%' : `${Math.round((0.1 + Math.min(1, level) * 0.9) * 100)}%` }} />
        ))}
      </div>

      {lost ? (
        <button type="button" className="compact-square-bottom compact-square-bottom--open" onClick={onExpand}>[ OPEN AUGUST ]</button>
      ) : (
        <HoldToStopButton className="compact-square-bottom compact-square-bottom--stop" onComplete={() => actions?.end()} title="Hold 1.5 s to end the meeting" ariaLabel="End Meeting (hold 1.5 seconds)" hint="[ HOLD ]">[ END MEETING ]</HoldToStopButton>
      )}
    </div>
  );
};
