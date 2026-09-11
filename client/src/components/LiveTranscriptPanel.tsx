import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveStatus, Speaker } from '../services/liveTranscriptionClient';

export interface LiveLine {
  speaker: Speaker;
  text: string;
}

export type { LiveStatus };

interface LiveTranscriptPanelProps {
  lines: LiveLine[];
  status: LiveStatus;
  error: string | null;
  micUnavailable: boolean;
  onPause: () => void;
  onResume: () => void;
  onCopyAll: () => void;
  onClose: () => void;
  onStop: () => void;
}

const STATUS_LABEL: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  listening: 'Listening',
  paused: 'Paused',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
};

const LiveTranscriptPanel: React.FC<LiveTranscriptPanelProps> = ({
  lines, status, error, micUnavailable, onPause, onResume, onCopyAll, onClose, onStop,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

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

  const isPaused = status === 'paused';
  const isDone = status === 'interrupted' || status === 'stopped';

  return (
    <aside className="live-panel" aria-label="Live transcript">
      <svg className="live-panel-hex-bg" viewBox="0 0 300 800" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <pattern id="live-hex-grid" width="28" height="48.5" patternUnits="userSpaceOnUse" patternTransform="scale(1.2)">
            <path d="M14 0L28 8.1V24.2L14 32.3L0 24.2V8.1Z" fill="none" stroke="currentColor" strokeWidth="0.5"/>
            <path d="M14 16.2L28 24.3V40.4L14 48.5L0 40.4V24.3Z" fill="none" stroke="currentColor" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#live-hex-grid)"/>
      </svg>
      <div className="live-panel-header">
        <div className="live-panel-title-row">
          <span className="live-panel-title">Live Transcript</span>
          <button type="button" className="live-panel-close" onClick={onClose} aria-label="Close live transcript">
            ×
          </button>
        </div>
        <div className={`live-panel-status live-panel-status--${status}`}>
          {status === 'listening' && <span className="live-panel-dot" aria-hidden="true" />}
          {STATUS_LABEL[status]}
        </div>
        {micUnavailable && (
          <div className="live-panel-notice">Microphone unavailable — showing Them only</div>
        )}
        {error && <div className="live-panel-warning">{error}</div>}
        <div className="live-panel-actions">
          <button
            type="button"
            className={`live-panel-btn${!isPaused ? ' live-panel-btn--pause' : ''}`}
            onClick={isPaused ? onResume : onPause}
            disabled={isDone}
          >
            {isPaused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="live-panel-btn" onClick={onCopyAll} disabled={lines.length === 0}>
            Copy All
          </button>
          <button type="button" className="live-panel-btn live-panel-btn--stop" onClick={onStop} disabled={isDone}>
            Stop
          </button>
        </div>
      </div>
      <div className="live-panel-divider" aria-hidden="true">
        <span className="live-panel-divider-dot" />
        <span className="live-panel-divider-dot" />
        <span className="live-panel-divider-dot" />
        <span className="live-panel-divider-dot" />
        <span className="live-panel-divider-dot" />
      </div>
      <div className="live-panel-body" ref={bodyRef} onScroll={handleScroll}>
        {lines.length === 0 && (status === 'listening' || status === 'connecting') && (
          <div className="live-panel-empty">Waiting for speech…</div>
        )}
        {lines.map((line, i) => (
          <div key={i} className="live-line">
            <span className={`live-line-speaker live-line-speaker--${line.speaker.toLowerCase()}`}>
              {line.speaker}:
            </span>
            <span className="live-line-text">{line.text}</span>
          </div>
        ))}
      </div>
      {!autoScroll && (
        <button type="button" className="live-panel-jump" onClick={jumpToLive} aria-label="Jump to latest">
          ↓ Live
        </button>
      )}
    </aside>
  );
};

export default LiveTranscriptPanel;
