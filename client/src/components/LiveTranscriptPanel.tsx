import React, { useCallback, useEffect, useRef, useState } from 'react';
import HoldToStopButton from './HoldToStopButton';
import type { LiveStatus, Speaker } from '../services/liveTranscriptionClient';

export interface LiveLinePart {
  id?: string;
  text: string;
  correctedAt?: number;
  /// AUG-164: text as recognized, before the first online correction; shown on hover.
  original?: string;
}

export interface LiveLine {
  speaker: Speaker;
  text: string;
  parts?: LiveLinePart[];
  /// AUG-181: '— mic muted —' divider inserted when the mic is muted; speaker is ignored.
  kind?: 'gap';
}

export type { LiveStatus };

interface LiveTranscriptPanelProps {
  lines: LiveLine[];
  status: LiveStatus;
  error: string | null;
  warning: string | null;
  micUnavailable: boolean;
  onPause: () => void;
  onResume: () => void;
  onCopyAll: () => void;
  onCopyAndClear: () => void;
  skipClearConfirmation: boolean; // AUG-182
  onClose: () => void;
  onStop: () => void;
  onClearAll: () => void;
  elapsed: string;
  onEndRecording: () => void;
  // Compact Mode (AUG-156): shrink August to a widget. Set only on the desktop shell.
  onCompact?: () => void;
  aside?: React.ReactNode; // AUG-165: Action items column next to the transcript (alias of columns)
  columns?: React.ReactNode; // AUG-199: side columns (action items / copilot / assistant) after the transcript canvas
  ctxCount?: number; // AUG-199: `CTX n` badge in the top bar
  onCtx?: () => void;
  // AUG-181: mute the mic in August's recording
  micMuted?: boolean;
  onToggleMute?: () => void;
  mutedHint?: boolean;
  mode?: 'live' | 'meeting'; // AUG-200: 'meeting' = recording without Live Text (action items + assistant only)
  onStartLive?: () => void;
}

const STATUS_LABEL: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  listening: 'Listening',
  paused: 'Paused',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
};

const LiveTranscriptPanel: React.FC<LiveTranscriptPanelProps> = ({
  lines, status, error, warning, micUnavailable, onPause, onResume, onCopyAll, onCopyAndClear, skipClearConfirmation, onClose, onStop, onClearAll, elapsed, onEndRecording, onCompact, aside, columns, ctxCount, onCtx, micMuted, onToggleMute, mutedHint, mode = 'live', onStartLive,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [confirmAction, setConfirmAction] = useState<'clearAll' | null>(null);

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const jumpToLive = () => {
    setAutoScroll(true);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  };

  const handleConfirm = () => {
    if (confirmAction === 'clearAll') onClearAll();
    setConfirmAction(null);
  };

  const handleClear = () => {
    if (skipClearConfirmation) onClearAll();
    else setConfirmAction('clearAll');
  };

  const isPaused = status === 'paused';
  const isDone = status === 'interrupted' || status === 'stopped';
  const meeting = mode === 'meeting'; // AUG-200

  return (
    <section className="live-panel" aria-label={meeting ? 'Meeting' : 'Live transcript'}>
      <div className="live-topbar">
        <span className="live-topbar-rec">
          <span className="recording-dot" aria-hidden="true" />
          <span className="live-topbar-timer">{elapsed}</span>
        </span>
        {meeting ? (
          <span className="live-panel-status live-panel-status--stopped">Live text off</span>
        ) : (
          <span className={`live-panel-status live-panel-status--${status}`}>
            {status === 'listening' && <span className="live-panel-dot" aria-hidden="true" />}
            {STATUS_LABEL[status]}
          </span>
        )}
        {!meeting && ctxCount !== undefined && ctxCount > 0 && (
          <button type="button" className="live-ctx-badge" onClick={onCtx} aria-label={`${ctxCount} hint, show COPILOT`}>CTX {ctxCount}</button>
        )}
        <div className="live-topbar-actions">
          {!meeting && <button type="button" className="live-panel-btn live-panel-btn--pause" onClick={isPaused ? onResume : onPause} disabled={isDone}>{isPaused ? 'Resume' : 'Pause'}</button>}
          {onToggleMute && (
            <button type="button" className={`live-panel-btn live-panel-btn--mute${micMuted ? ' live-panel-btn--mute-on' : ''}`} onClick={onToggleMute} aria-pressed={micMuted} title="Mute in August's recording">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="12"/><path d={micMuted ? 'M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18' : 'M5 11a7 7 0 0 0 14 0M12 18v3'}/></svg>
              {' '}{micMuted ? 'Unmute mic' : 'Mute mic'}
            </button>
          )}
          {meeting ? (
            <button type="button" className="live-panel-btn live-panel-btn--start" onClick={onStartLive} title="Start live text. Recording continues.">▶&#xFE0E; Start Live Text</button>
          ) : (
            <>
              <button type="button" className="live-panel-btn live-panel-btn--copy" onClick={onCopyAll} disabled={lines.length === 0}>Copy All</button>
              <button type="button" className="live-panel-btn live-panel-btn--copy" onClick={onCopyAndClear} disabled={lines.length === 0} title="Copy the live transcript and clear the window">Copy &amp; Clear</button>
              <button type="button" className="live-panel-btn live-panel-btn--clear" onClick={handleClear} disabled={lines.length === 0} title="Clear the live window; recording continues">Clear</button>
              <HoldToStopButton className="live-panel-btn live-panel-btn--stop" onComplete={onStop} disabled={isDone} title="Hold 1.5 s to stop live text. Recording continues." ariaLabel="Stop Live Text (hold 1.5 seconds)">Stop Live Text</HoldToStopButton>
            </>
          )}
          <HoldToStopButton className="live-panel-btn live-panel-btn--end" onComplete={onEndRecording} title="Hold 1.5 s to end the meeting: recording stops and the final transcript is made." ariaLabel="End Meeting (hold 1.5 seconds)">End Meeting</HoldToStopButton>
        </div>
        <span className="live-topbar-spacer" />
        {onCompact && (
          <button type="button" className="live-panel-btn live-panel-btn--compact" onClick={onCompact} title="Shrink August to a widget (Ctrl/Cmd+Shift+C)">⤡ Compact</button>
        )}
        <button type="button" className="live-panel-close" onClick={onClose} aria-label={meeting ? 'Hide meeting panel' : 'Hide live transcript'} title={meeting ? 'Hide meeting panel' : 'Hide live transcript'}>×</button>
      </div>
      {confirmAction && (
        <div className="live-panel-confirm">
          <span className="live-panel-confirm-text">Clear live transcript?</span>
          <div className="live-panel-confirm-actions">
            <button type="button" className="live-panel-btn live-panel-btn--confirm-yes" onClick={handleConfirm}>
              Yes, clear
            </button>
            <button type="button" className="live-panel-btn live-panel-btn--confirm-no" onClick={() => setConfirmAction(null)}>
              No, return
            </button>
          </div>
        </div>
      )}

      {(meeting ? mutedHint : (micUnavailable || error || warning || mutedHint)) && (
        <div className="live-panel-notices">
          {!meeting && micUnavailable && <div className="live-panel-notice">Microphone unavailable — showing Them only</div>}
          {!meeting && error && <div className="live-panel-warning">{error}</div>}
          {!meeting && warning && <div className="live-panel-notice">{warning}</div>}
          {mutedHint && <div className="live-panel-notice live-panel-notice--muted">You're muted in August</div>}
        </div>
      )}
      <div className="live-panel-main">
        <div className="live-panel-canvas">
          <svg className="live-panel-hex-bg" viewBox="0 0 300 800" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <pattern id="live-hex-grid" width="28" height="48.5" patternUnits="userSpaceOnUse" patternTransform="scale(1.2)">
                <path d="M14 0L28 8.1V24.2L14 32.3L0 24.2V8.1Z" fill="none" stroke="currentColor" strokeWidth="0.5"/>
                <path d="M14 16.2L28 24.3V40.4L14 48.5L0 40.4V24.3Z" fill="none" stroke="currentColor" strokeWidth="0.5"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#live-hex-grid)"/>
          </svg>
          {meeting ? (
            <div className="live-panel-body">
              <div className="live-panel-empty live-panel-empty--meeting">
                Live text is off. The recording continues; the full transcript is made after End Meeting.<br />
                Add action items by hand or ask the assistant.
                <div className="live-panel-empty-acts">
                  <button type="button" className="live-panel-btn live-panel-btn--start" onClick={onStartLive}>▶&#xFE0E; Start Live Text</button>
                </div>
              </div>
            </div>
          ) : (
          <div className="live-panel-body" ref={bodyRef} onScroll={handleScroll}>
            {lines.length === 0 && (status === 'listening' || status === 'connecting') && (
              <div className="live-panel-empty">Waiting for speech…</div>
            )}
            {lines.map((line, i) => line.kind === 'gap' ? (
              <div key={i} className="live-line live-line--gap">{line.text}</div>
            ) : (
              <div key={i} className="live-line">
                <span className={`live-line-speaker live-line-speaker--${line.speaker.toLowerCase()}`}>
                  {line.speaker}:
                </span>
                <span className="live-line-text">
                  {line.parts && line.parts.length > 0
                    ? line.parts.map((p, j) => (
                      <React.Fragment key={`${p.id ?? j}-${p.correctedAt ?? 0}`}>
                        {j > 0 && ' '}
                        <span
                          className={p.correctedAt ? 'live-line-part live-line-part--corrected' : 'live-line-part'}
                          data-original={p.correctedAt && p.original ? p.original : undefined}
                        >
                          {p.text}
                        </span>
                      </React.Fragment>
                    ))
                    : line.text}
                </span>
              </div>
            ))}
          </div>
          )}
          {!meeting && !autoScroll && (
            <button type="button" className="live-panel-jump" onClick={jumpToLive} aria-label="Jump to latest">
              ↓ Live
            </button>
          )}
        </div>
        {columns}
        {aside}
      </div>
    </section>
  );
};

export default LiveTranscriptPanel;
