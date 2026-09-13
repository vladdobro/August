import React, { useMemo, useState, useRef, useEffect } from 'react';
import type { SessionMetadata } from '../types';
import PraxisModal from './PraxisModal';

interface TranscriptViewProps {
  session: SessionMetadata;
  transcript: string;
  onRetranscribe?: (language?: string, boost?: boolean) => Promise<void>;
  onCancel?: () => Promise<void>;
  ffmpegAvailable?: boolean;
}

interface ParsedLine {
  timestamp: string | null;
  role: string | null;
  text: string;
}

const TIMESTAMP_LINE = /^\[(\d{2}:\d{2}:\d{2})\]\s?(?:\[(Me|Them)\]\s)?(.*)$/;

function parseTranscript(markdown: string): ParsedLine[] {
  const lines = markdown.split('\n');
  const result: ParsedLine[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('- Date:') || line.startsWith('- Duration:')) continue;

    const match = line.match(TIMESTAMP_LINE);
    if (match) {
      result.push({ timestamp: match[1], role: match[2] || null, text: match[3] });
    } else {
      result.push({ timestamp: null, role: null, text: line });
    }
  }

  return result;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function languageLabel(language: string): string {
  switch (language) {
    case 'en':
      return 'English';
    case 'ru':
      return 'Russian';
    case 'auto':
    default:
      return 'Auto-detect';
  }
}

function timestampToSeconds(ts: string): number {
  const [h, m, s] = ts.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function secondsToSrtTimestamp(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},000`;
}

function generateTextOnly(lines: ParsedLine[]): string {
  return lines.map(l => l.role ? `[${l.role}] ${l.text}` : l.text).join('\n');
}

function generateTxtWithTimestamps(lines: ParsedLine[]): string {
  return lines
    .map(l => {
      const rolePrefix = l.role ? `[${l.role}] ` : '';
      return l.timestamp ? `[${l.timestamp}] ${rolePrefix}${l.text}` : l.text;
    })
    .join('\n');
}

function generateSrt(lines: ParsedLine[]): string {
  const timestamped = lines.filter(l => l.timestamp !== null);
  if (timestamped.length === 0) return '';

  return timestamped
    .map((line, i) => {
      const startSec = timestampToSeconds(line.timestamp!);
      const endSec =
        i < timestamped.length - 1
          ? timestampToSeconds(timestamped[i + 1].timestamp!)
          : startSec + 5;
      const start = secondsToSrtTimestamp(startSec);
      const end = secondsToSrtTimestamp(endSec);
      return `${i + 1}\n${start} --> ${end}\n${line.role ? `[${line.role}] ` : ''}${line.text}`;
    })
    .join('\n\n');
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const CHRONO_CIRC = 2 * Math.PI * 88;

function generateTicks(): React.ReactNode[] {
  const ticks: React.ReactNode[] = [];
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * 2 * Math.PI;
    const major = i % 5 === 0;
    const r1 = major ? 96 : 98;
    const r2 = 104;
    ticks.push(
      <line
        key={i}
        x1={110 + r1 * Math.cos(angle)}
        y1={110 + r1 * Math.sin(angle)}
        x2={110 + r2 * Math.cos(angle)}
        y2={110 + r2 * Math.sin(angle)}
        className="chrono-tick"
        strokeWidth={major ? 1.5 : 1}
      />
    );
  }
  return ticks;
}

const CHRONO_TICKS = generateTicks();

function formatChronoFull(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}

const ChronoRing: React.FC<{ session: SessionMetadata }> = ({ session }) => {
  const [remainMs, setRemainMs] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);

  const estimatedTotalMs = (session.estimatedDuration ?? 0) * 1000;
  const startedAtMs = session.transcriptionStartedAt
    ? new Date(session.transcriptionStartedAt).getTime()
    : 0;

  useEffect(() => {
    if (!startedAtMs || estimatedTotalMs <= 0) return;

    const tick = () => {
      const now = Date.now();
      const elapsed = now - startedAtMs;
      const remain = Math.max(0, estimatedTotalMs - elapsed);
      const prog = Math.min(elapsed / estimatedTotalMs, 1);

      setElapsedMs(elapsed);
      setRemainMs(remain);
      setProgress(prog);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [startedAtMs, estimatedTotalMs]);

  const offset = CHRONO_CIRC * (1 - progress);
  const isLastMinute = remainMs < 60000 && remainMs > 0;
  const isZeroed = remainMs <= 0 && progress >= 1;

  const phaseClass = isZeroed
    ? 'chrono-phase-zeroed'
    : isLastMinute
      ? 'chrono-phase-red'
      : '';

  const finishTime = new Date(Date.now() + remainMs);
  const finishStr = `${String(finishTime.getHours()).padStart(2, '0')}:${String(finishTime.getMinutes()).padStart(2, '0')}`;

  if (!startedAtMs || estimatedTotalMs <= 0) {
    return (
      <div className="transcription-progress-wrapper">
        <div className="transcription-progress-bar">
          <div className="transcription-progress-fill" />
        </div>
        <p className="transcription-status-text">Transcribing audio...</p>
      </div>
    );
  }

  return (
    <div className={`chrono-container ${phaseClass}`}>
      {isZeroed && (
        <div className="chrono-exterminatus">
          <span className="chrono-ext-line" />
          <span className="chrono-ext-text">Exterminatus Initiated</span>
          <span className="chrono-ext-line chrono-ext-line--bottom" />
        </div>
      )}

      <div className="chrono-ring-wrap">
        <svg className="chrono-ring-svg" viewBox="0 0 220 220">
          <g>{CHRONO_TICKS}</g>
          <circle cx="110" cy="110" r="88" className="chrono-track" />
          <circle
            cx="110" cy="110" r="88"
            className="chrono-glow"
            strokeDasharray={CHRONO_CIRC}
            strokeDashoffset={offset}
          />
          <circle
            cx="110" cy="110" r="88"
            className="chrono-fill"
            strokeDasharray={CHRONO_CIRC}
            strokeDashoffset={offset}
          />
          <circle cx="110" cy="110" r="88" className="chrono-pulse-ring" />
          <circle cx="110" cy="110" r="88" className="chrono-pulse-ring chrono-pulse-ring--2" />
          <circle cx="110" cy="110" r="88" className="chrono-pulse-ring--3 chrono-pulse-ring" />
        </svg>
        <div className="chrono-center">
          <div className="chrono-label">remaining</div>
          <div className="chrono-digits">{isZeroed ? '00:00:00' : formatChronoFull(remainMs)}</div>
          <div className="chrono-pct">{Math.round(progress * 100)}%</div>
        </div>
      </div>

      <div className="chrono-meta">
        <div className="chrono-meta-item">
          <div className="chrono-meta-dot" />
          <span className="chrono-meta-label">Elapsed</span>
          <span className="chrono-meta-val">{formatDuration(Math.floor(elapsedMs / 1000))}</span>
        </div>
        <div className="chrono-meta-item">
          <span className="chrono-meta-label">Audio</span>
          <span className="chrono-meta-val">{formatDuration(session.duration)}</span>
        </div>
      </div>

      {!isZeroed && (
        <div className="chrono-info-bar">
          <div className="chrono-info-dot" />
          <span className="chrono-info-text">
            Завершение в <span className="chrono-info-time">{finishStr}</span>
          </span>
        </div>
      )}
    </div>
  );
};

const TranscriptView: React.FC<TranscriptViewProps> = ({ session, transcript, onRetranscribe, onCancel, ffmpegAvailable = false }) => {
  const [feedbackText, setFeedbackText] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const retranscribeRef = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [boostEnabled, setBoostEnabled] = useState(false);
  const [failedMenuOpen, setFailedMenuOpen] = useState(false);
  const failedMenuRef = useRef<HTMLDivElement>(null);
  const [showPraxisModal, setShowPraxisModal] = useState(false);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!retranscribeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (retranscribeRef.current && !retranscribeRef.current.contains(e.target as Node)) {
        setRetranscribeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [retranscribeOpen]);

  useEffect(() => {
    if (!failedMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (failedMenuRef.current && !failedMenuRef.current.contains(e.target as Node)) {
        setFailedMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [failedMenuOpen]);

  const handleRetranscribe = async (language?: string) => {
    if (!onRetranscribe || retrying) return;
    setRetrying(true);
    setRetranscribeOpen(false);
    try {
      await onRetranscribe(language, boostEnabled);
    } finally {
      setRetrying(false);
    }
  };

  const handleFailedRetranscribe = async (language?: string) => {
    if (!onRetranscribe || retrying) return;
    setRetrying(true);
    setFailedMenuOpen(false);
    try {
      await onRetranscribe(language, boostEnabled);
    } finally {
      setRetrying(false);
    }
  };

  const handleCancel = async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  const parsedLines = useMemo(() => parseTranscript(transcript), [transcript]);

  const showFeedback = (text: string) => {
    setFeedbackText(text);
    setDropdownOpen(false);
    setTimeout(() => setFeedbackText(null), 2000);
  };

  const handleCopyWithTimestamps = async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      showFeedback('Copied!');
    } catch {
      // clipboard API unavailable
    }
  };

  const handleCopyTextOnly = async () => {
    try {
      const text = generateTextOnly(parsedLines);
      await navigator.clipboard.writeText(text);
      showFeedback('Copied!');
    } catch {
      // clipboard API unavailable
    }
  };

  const handleDownloadTxt = () => {
    const content = generateTxtWithTimestamps(parsedLines);
    const safeName = session.title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'transcript';
    downloadFile(content, `${safeName}.txt`, 'text/plain');
    setDropdownOpen(false);
  };

  const handleDownloadSrt = () => {
    const content = generateSrt(parsedLines);
    const safeName = session.title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'transcript';
    downloadFile(content, `${safeName}.srt`, 'application/x-subrip');
    setDropdownOpen(false);
  };

  const handleSendToPraxis = () => {
    setDropdownOpen(false);
    setShowPraxisModal(true);
  };

  return (
    <div className="transcript-view">
      <div className="transcript-circuit-header">
        <div className="transcript-circuit-info">
          <h2 className="transcript-circuit-title">{session.title}</h2>
          <div className="transcript-circuit-meta">
            <span>{new Date(session.createdAt).toLocaleString()}</span>
            <span className="meta-separator">&bull;</span>
            <span>{formatDuration(session.duration)}</span>
            <span className="meta-separator">&bull;</span>
            <span>{languageLabel(session.language)}</span>
            <span className="meta-separator">&bull;</span>
            <span className={`status-badge status-${session.status}`}>{session.status}</span>
          </div>
        </div>

        {(session.status === 'completed' || session.status === 'failed') && (
          <div className="transcript-circuit-diagram">
            <svg className="transcript-circuit-svg" viewBox="0 0 340 110" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              {session.status === 'completed' && (
                <>
                  <line x1="170" y1="28" x2="85" y2="82" className="transcript-circuit-line" />
                  <line x1="170" y1="28" x2="170" y2="82" className="transcript-circuit-line" />
                </>
              )}
              {onRetranscribe && (
                <line x1="170" y1="28" x2="255" y2="82" className="transcript-circuit-line" />
              )}
            </svg>

            <div className="transcript-info-node">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </div>

            {session.status === 'completed' && (
              <div className="transcript-action-wrap transcript-action-wrap--copy">
                <button type="button" className="transcript-action-node" onClick={handleCopyWithTimestamps} aria-label="Copy transcript">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span className="transcript-action-label">{feedbackText || 'Copy'}</span>
                </button>
              </div>
            )}

            {session.status === 'completed' && (
              <div className="transcript-action-wrap transcript-action-wrap--export" ref={dropdownRef}>
                <button type="button" className="transcript-action-node" onClick={() => setDropdownOpen(prev => !prev)} aria-label="Export options">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span className="transcript-action-label">Export</span>
                </button>
                {dropdownOpen && (
                  <div className="export-menu">
                    <button type="button" className="export-menu-item" onClick={handleCopyWithTimestamps}>Copy with timestamps</button>
                    <button type="button" className="export-menu-item" onClick={handleCopyTextOnly}>Copy text only</button>
                    <div className="export-menu-divider" />
                    <button type="button" className="export-menu-item" onClick={handleDownloadTxt}>Download .txt</button>
                    <button type="button" className="export-menu-item" onClick={handleDownloadSrt}>Download .srt</button>
                    <div className="export-menu-divider" />
                    <button type="button" className="export-menu-item export-menu-item--praxis" onClick={handleSendToPraxis}>Send to Praxis</button>
                  </div>
                )}
              </div>
            )}

            {onRetranscribe && (
              <div className="transcript-action-wrap transcript-action-wrap--retranscribe" ref={retranscribeRef}>
                <button type="button" className="transcript-action-node" onClick={() => setRetranscribeOpen(prev => !prev)} disabled={retrying} aria-label="Re-transcribe">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                  <span className="transcript-action-label">{retrying ? '...' : 'Redo'}</span>
                </button>
                {retranscribeOpen && (
                  <div className="retranscribe-menu">
                    <label
                      className={`retranscribe-boost-toggle${!ffmpegAvailable ? ' retranscribe-boost-toggle--disabled' : ''}`}
                      title={!ffmpegAvailable ? 'Requires ffmpeg' : 'Amplify quiet audio before transcription'}
                    >
                      <input
                        type="checkbox"
                        checked={boostEnabled}
                        onChange={(e) => setBoostEnabled(e.target.checked)}
                        disabled={!ffmpegAvailable}
                      />
                      <span>Boost audio</span>
                    </label>
                    <div className="retranscribe-menu-divider" />
                    <button type="button" className="retranscribe-menu-item" onClick={() => handleRetranscribe('ru')}>Russian</button>
                    <button type="button" className="retranscribe-menu-item" onClick={() => handleRetranscribe('en')}>English</button>
                    <button type="button" className="retranscribe-menu-item" onClick={() => handleRetranscribe('auto')}>Auto-detect</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="transcript-body">
        {session.status === 'uploading' && (
          <div className="transcript-status-panel">
            <div className="spinner" />
            <p>Uploading audio...</p>
          </div>
        )}

        {session.status === 'transcribing' && (
          <div className="transcript-status-panel">
            <ChronoRing session={session} />
            <div className="transcription-controls">
              {onCancel && (
                <button
                  type="button"
                  className="transcription-cancel-btn"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? 'Cancelling...' : 'Cancel'}
                </button>
              )}
              {onRetranscribe && (
                <div className="transcription-restart-wrap" ref={retranscribeRef}>
                  <button
                    type="button"
                    className="transcription-restart-btn"
                    onClick={() => setRetranscribeOpen(prev => !prev)}
                    disabled={retrying}
                  >
                    {retrying ? 'Restarting...' : 'Restart'}
                  </button>
                  {retranscribeOpen && (
                    <div className="retranscribe-menu retranscribe-menu--above">
                      <label
                        className={`retranscribe-boost-toggle${!ffmpegAvailable ? ' retranscribe-boost-toggle--disabled' : ''}`}
                        title={!ffmpegAvailable ? 'Requires ffmpeg' : 'Amplify quiet audio before transcription'}
                      >
                        <input
                          type="checkbox"
                          checked={boostEnabled}
                          onChange={(e) => setBoostEnabled(e.target.checked)}
                          disabled={!ffmpegAvailable}
                        />
                        <span>Boost audio</span>
                      </label>
                      <div className="retranscribe-menu-divider" />
                      <button type="button" className="retranscribe-menu-item" onClick={() => handleRetranscribe('ru')}>Russian</button>
                      <button type="button" className="retranscribe-menu-item" onClick={() => handleRetranscribe('en')}>English</button>
                      <button type="button" className="retranscribe-menu-item" onClick={() => handleRetranscribe('auto')}>Auto-detect</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {session.status === 'failed' && (
          <div className="transcript-status-panel error">
            <p className="error-title">Transcription failed</p>
            <p className="error-message">{session.error || 'An unknown error occurred.'}</p>
            {onRetranscribe && (
              <div className="failed-recovery" ref={failedMenuRef}>
                {session.error?.includes('Audio file no longer exists') ? (
                  <p className="failed-no-audio">Audio file no longer exists — this session cannot be re-transcribed.</p>
                ) : (
                  <>
                    <button
                      type="button"
                      className="retry-button"
                      onClick={() => setFailedMenuOpen(prev => !prev)}
                      disabled={retrying}
                    >
                      {retrying ? 'Starting...' : 'Transcribe again'}
                    </button>
                    {failedMenuOpen && (
                      <div className="retranscribe-menu retranscribe-menu--above">
                        <label
                          className={`retranscribe-boost-toggle${!ffmpegAvailable ? ' retranscribe-boost-toggle--disabled' : ''}`}
                          title={!ffmpegAvailable ? 'Requires ffmpeg' : 'Amplify quiet audio before transcription'}
                        >
                          <input
                            type="checkbox"
                            checked={boostEnabled}
                            onChange={(e) => setBoostEnabled(e.target.checked)}
                            disabled={!ffmpegAvailable}
                          />
                          <span>Boost audio</span>
                        </label>
                        <div className="retranscribe-menu-divider" />
                        <button type="button" className="retranscribe-menu-item" onClick={() => handleFailedRetranscribe('ru')}>Russian</button>
                        <button type="button" className="retranscribe-menu-item" onClick={() => handleFailedRetranscribe('en')}>English</button>
                        <button type="button" className="retranscribe-menu-item" onClick={() => handleFailedRetranscribe('auto')}>Auto-detect</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {session.status === 'completed' && (
          <div className="transcript-lines">
            {parsedLines.length === 0 && (
              <p className="transcript-empty">No speech was detected in this recording.</p>
            )}
            {parsedLines.map((line, index) => (
              <div className="transcript-line" key={index}>
                {line.timestamp && <span className="transcript-timestamp">{line.timestamp}</span>}
                {line.role && <span className={`transcript-role transcript-role-${line.role.toLowerCase()}`}>{line.role}</span>}
                <span className="transcript-text">{line.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showPraxisModal && (
        <PraxisModal
          sessionId={session.id}
          sessionTitle={session.title}
          onClose={() => setShowPraxisModal(false)}
        />
      )}
    </div>
  );
};

export default TranscriptView;
