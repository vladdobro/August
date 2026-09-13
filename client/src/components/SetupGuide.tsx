import React, { useCallback, useEffect, useState } from 'react';
import { fetchSetupStatus, SETUP_PROGRESS_URL } from '../api';
import type { HealthStatus, ModelSetupStatus } from '../types';

interface SetupGuideProps {
  health: HealthStatus;
  onRefresh: () => Promise<void>;
  onDismiss: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

const MODEL_PATH = 'whisper/models/ggml-large-v3-turbo-q8_0.bin';

interface HintPopupProps {
  text: string;
}

const HintPopup: React.FC<HintPopupProps> = ({ text }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="diag-hint-wrap">
      <button
        className="diag-hint-trigger"
        onClick={() => setOpen(!open)}
        onBlur={() => setOpen(false)}
        type="button"
        aria-label="More info"
      >?</button>
      {open && <span className="diag-hint-popup">{text}</span>}
    </span>
  );
};

const NecronLogo: React.FC = () => (
  <svg
    className="diag-logo"
    width="72"
    height="72"
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ transform: 'rotate(45deg)' }}
  >
    <circle cx="50" cy="50" r="16" stroke="currentColor" strokeWidth="2.5" fill="none" />
    <circle cx="50" cy="50" r="12" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.4" />
    <line x1="50" y1="34" x2="50" y2="14" stroke="currentColor" strokeWidth="2" />
    <path d="M42 10 Q50 18 58 10" stroke="currentColor" strokeWidth="2" fill="none" />
    <circle cx="50" cy="14" r="2" fill="currentColor" />
    <line x1="66" y1="50" x2="90" y2="50" stroke="currentColor" strokeWidth="2" />
    <circle cx="90" cy="50" r="2.5" fill="currentColor" />
    <line x1="34" y1="50" x2="10" y2="50" stroke="currentColor" strokeWidth="2" />
    <circle cx="10" cy="50" r="2.5" fill="currentColor" />
    <line x1="40" y1="63" x2="18" y2="88" stroke="currentColor" strokeWidth="2" />
    <circle cx="18" cy="88" r="2" fill="currentColor" />
    <line x1="60" y1="63" x2="82" y2="88" stroke="currentColor" strokeWidth="2" />
    <circle cx="82" cy="88" r="2" fill="currentColor" />
    <line x1="50" y1="66" x2="50" y2="88" stroke="currentColor" strokeWidth="2" />
    <circle cx="50" cy="88" r="2" fill="currentColor" />
  </svg>
);

const SetupGuide: React.FC<SetupGuideProps> = ({ health, onRefresh, onDismiss }) => {
  const [modelStatus, setModelStatus] = useState<ModelSetupStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showSkipWarning, setShowSkipWarning] = useState(false);
  const [noGpu, setNoGpu] = useState(false);

  const setupCommand = isMac
    ? 'brew install whisper-cpp ffmpeg'
    : 'powershell -ExecutionPolicy Bypass -File scripts\\setup-whisper.ps1';
  const pollModelStatus = useCallback(() => {
    let es: EventSource | null = null;
    fetchSetupStatus()
      .then((s) => {
        setModelStatus(s);
        if (s.state === 'downloading') {
          es = new EventSource(SETUP_PROGRESS_URL);
          es.onmessage = (event) => {
            try {
              const parsed = JSON.parse(event.data) as ModelSetupStatus;
              setModelStatus(parsed);
              if (parsed.state !== 'downloading') {
                es?.close();
                void onRefresh();
              }
            } catch { /* ignore */ }
          };
        }
      })
      .catch(() => {});
    return () => { es?.close(); };
  }, [onRefresh]);

  useEffect(() => {
    void onRefresh();
    return pollModelStatus();
  }, [pollModelStatus, onRefresh]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(setupCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
      pollModelStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const handleSkip = () => {
    if (showSkipWarning) {
      onDismiss();
    } else {
      setShowSkipWarning(true);
    }
  };

  const isDownloading = modelStatus?.state === 'downloading';

  const whisperReady = health.whisperAvailable;
  const modelReady = health.modelAvailable && (!modelStatus || modelStatus.state !== 'downloading');
  const ffmpegReady = health.ffmpegAvailable;
  const allReady = whisperReady && modelReady;

  return (
    <div className="diag-page">
      <div className="diag-card">
        <div className="diag-header">
          <NecronLogo />
          <h2 className="diag-title">August Diagnostics</h2>
          <p className="diag-subtitle">
            August requires local components to be installed.
            <HintPopup text="Whisper is the speech-to-text engine. The GGML model contains the neural network weights. FFmpeg handles audio format conversion." />
          </p>
        </div>

        {/* Circuit node layout — all positions in % so SVG lines and CSS nodes share the same coordinate space */}
        <div className="diag-circuit">
          {/* SVG lines — no viewBox, width/height 100%, percentage coords match CSS */}
          <svg className="diag-circuit-lines" width="100%" height="100%">
            {/* Whisper(30%,18%) → GGML(70%,48%) — dots 6px outside circle edges */}
            <line x1="37%" y1="23%" x2="62%" y2="42%" stroke="rgba(0,200,118,0.2)" strokeWidth="2" strokeDasharray="6 4" className="diag-line-anim" />
            <circle cx="37%" cy="23%" r="4" fill="rgba(0,200,118,0.4)" />
            <circle cx="62%" cy="42%" r="4" fill="rgba(0,200,118,0.4)" />
            {/* GGML(70%,48%) → FFmpeg(34%,80%) — dots 6px outside circle edges */}
            {!isMac && (
              <>
                <line x1="62%" y1="55%" x2="40%" y2="74%" stroke="rgba(0,200,118,0.2)" strokeWidth="2" strokeDasharray="6 4" className="diag-line-anim" />
                <circle cx="62%" cy="55%" r="4" fill="rgba(0,200,118,0.4)" />
                <circle cx="40%" cy="74%" r="4" fill="rgba(0,200,118,0.4)" />
              </>
            )}
          </svg>

          {/* Whisper — circle center at 30%,18%; circle 70px; text right */}
          <div className="diag-node diag-node--whisper">
            <div className={`diag-node-circle diag-circle--yellow ${whisperReady ? 'diag-circle--ok' : ''}`}>
              {whisperReady ? (
                <svg className="diag-check" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00c876" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <span className="diag-node-dot" />
              )}
            </div>
            <div className="diag-node-info">
              <span className="diag-node-label">
                Whisper Engine
                <HintPopup text="Local speech-to-text engine built from whisper.cpp with GPU acceleration." />
              </span>
              <span className={`diag-node-status ${whisperReady ? 'diag-node-status--ready' : ''}`}>
                {whisperReady ? 'Operational' : 'Not installed'}
              </span>
            </div>
          </div>

          {/* GGML — circle center at 70%,48%; circle 84px; text left */}
          <div className="diag-node diag-node--ggml">
            <div className="diag-node-info diag-node-info--left">
              <span className="diag-node-label">
                <HintPopup text="Neural network weights (~874 MB). Required for the whisper engine to transcribe audio." />
                GGML Model
              </span>
              <span className={`diag-node-status ${modelReady ? 'diag-node-status--ready' : ''}`}>
                {modelReady
                  ? 'Operational'
                  : isDownloading
                    ? `Downloading — ${modelStatus!.percent.toFixed(1)}%`
                    : 'Not downloaded (~874 MB)'}
              </span>
            </div>
            <div className={`diag-node-circle diag-circle--red ${modelReady ? 'diag-circle--ok' : ''} ${isDownloading ? 'diag-circle--pulse' : ''}`}>
              {modelReady ? (
                <svg className="diag-check" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00c876" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : isDownloading ? (
                <svg className="diag-download-arrow" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#d4a028" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v13" />
                  <polyline points="7 11 12 16 17 11" />
                  <line x1="5" y1="21" x2="19" y2="21" />
                </svg>
              ) : (
                <span className="diag-node-dot" />
              )}
            </div>
          </div>

          {/* FFmpeg — circle center at 34%,80%; circle 62px; text right (Windows only) */}
          {!isMac && (
            <div className="diag-node diag-node--ffmpeg">
              <div className={`diag-node-circle diag-circle--green ${ffmpegReady ? 'diag-circle--ok' : ''}`}>
                {ffmpegReady ? (
                  <svg className="diag-check" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00c876" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                )}
              </div>
              <div className="diag-node-info">
                <span className="diag-node-label">
                  FFmpeg <span className="diag-tag-optional">OPT</span>
                  <HintPopup text="Multimedia toolkit for audio format conversion (mp3, m4a → wav). Optional — most formats work without it." />
                </span>
                <span className={`diag-node-status ${ffmpegReady ? 'diag-node-status--ready' : ''}`}>
                  {ffmpegReady ? 'Available' : 'Not required'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Download progress */}
        {isDownloading && modelStatus && (
          <div className="diag-section">
            <div className="diag-section-title">Model Download</div>
            <div className="diag-progress">
              <div className="diag-progress-track">
                <div className="diag-progress-fill" style={{ width: `${modelStatus.percent}%` }} />
              </div>
              <div className="diag-progress-text">
                {modelStatus.verifying
                  ? 'Verifying checksum...'
                  : `${formatBytes(modelStatus.bytesDownloaded)} / ${formatBytes(modelStatus.totalBytes)} — ${modelStatus.percent.toFixed(1)}%`}
              </div>
            </div>
          </div>
        )}

        {modelStatus?.error && (
          <div className="diag-error">{modelStatus.error}</div>
        )}

        {/* Build whisper section */}
        {!health.whisperAvailable && (
          <div className="diag-section">
            <div className="diag-section-title">
              {isMac ? 'Install Components' : 'Build Whisper Engine'}
            </div>
            <p className="diag-section-desc">
              {isMac
                ? 'Install whisper and FFmpeg via Homebrew.'
                : 'Run this command in a terminal at the project root. It installs build tools and compiles whisper.cpp.'}
            </p>
            <div className="diag-code-block">
              <code className="diag-code-text">{setupCommand}</code>
              <button className="diag-code-copy" onClick={handleCopy} type="button" title="Copy command">
                {copied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        )}

        {/* GPU toggle — only when whisper is missing (Vulkan concern) */}
        {!health.whisperAvailable && !noGpu && (
          <button
            className="diag-btn diag-btn--nogpu"
            onClick={() => setNoGpu(true)}
            type="button"
          >
            I don't need GPU support
          </button>
        )}

        {/* Expanded options — shown after GPU dismiss, or directly when only model is missing */}
        {(() => {
          const whisperMissing = !health.whisperAvailable;
          const modelMissing = !modelReady && !isDownloading;
          const showExpanded = whisperMissing ? noGpu : modelMissing;
          if (!showExpanded) return null;

          let step = 0;
          return (
            <div className="diag-nogpu-options">
              {whisperMissing && (
                <p className={`diag-info-line diag-reveal diag-reveal--${++step}`}>
                  Your transcription will run much slower with CPU execution.
                </p>
              )}

              {modelMissing && (
                <button
                  className={`diag-download-btn diag-reveal diag-reveal--${++step}`}
                  type="button"
                  onClick={() => {
                    fetch('/api/setup/download-model', { method: 'POST' }).catch(() => {});
                    pollModelStatus();
                  }}
                >
                  Download GGML model
                </button>
              )}
            </div>
          );
        })()}

        {/* Skip warning */}
        {showSkipWarning && (
          <div className="diag-skip-warning">
            Transcription will not work without the required components. Continue anyway?
          </div>
        )}

        {/* Actions */}
        {allReady ? (
          <button className="diag-proceed" onClick={onDismiss} type="button">
            <span className="diag-proceed-subtitle">Transcription operations</span>
            <span className="diag-proceed-title">Proceed</span>
            <span className="diag-proceed-scanlines" />
          </button>
        ) : (
          <div className="diag-actions">
            <button
              className="diag-btn diag-btn--refresh"
              onClick={handleRefresh}
              disabled={refreshing}
              type="button"
            >
              {refreshing ? 'Checking...' : 'Refresh Status'}
            </button>
            <button className="diag-btn diag-btn--skip" onClick={handleSkip} type="button">
              {showSkipWarning ? 'Yes, skip setup' : 'Skip Setup'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SetupGuide;
