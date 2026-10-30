import React, { useCallback, useEffect, useState } from 'react';
import { fetchSetupStatus, SETUP_PROGRESS_URL, switchEngine, CUDA_PROGRESS_URL, fetchLlmStatus, retryLlmDownload, testLlm } from '../api';
import type { HealthStatus, LlmStatus, ModelSetupStatus } from '../types';
import { llmNodeState, subscribeLlmProgress } from '../services/llm';

interface SetupGuideProps {
  health: HealthStatus;
  onRefresh: () => Promise<void>;
  onDismiss: () => void;
  // Opens Settings on the Transcription tab, where turning the local model on asks for confirmation first (AUG-162).
  onOpenLlmSettings: () => void;
  // True while the Settings modal is open; closing it refreshes the Language Model status at once.
  settingsOpen: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

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

const SetupGuide: React.FC<SetupGuideProps> = ({ health, onRefresh, onDismiss, onOpenLlmSettings, settingsOpen }) => {
  const [modelStatus, setModelStatus] = useState<ModelSetupStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [ffmpegCopied, setFfmpegCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showSkipWarning, setShowSkipWarning] = useState(false);
  const [noGpu, setNoGpu] = useState(false);
  const [engineSwitching, setEngineSwitching] = useState(false);
  const [cudaProgress, setCudaProgress] = useState(0);
  const [cudaError, setCudaError] = useState<string | null>(null);
  const [switchedToGpu, setSwitchedToGpu] = useState(false);

  // Opt-in local language model (AUG-162): informational only, never part of allReady.
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [llmTest, setLlmTest] = useState<{ reply: string; totalMs: number } | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestError, setLlmTestError] = useState<string | null>(null);

  const refreshLlmStatus = useCallback(() => {
    return fetchLlmStatus().then(setLlmStatus).catch(() => {});
  }, []);

  const watchLlmDownload = useCallback(() => {
    return subscribeLlmProgress(
      (download) => setLlmStatus((prev) => (prev ? { ...prev, download } : prev)),
      () => { void refreshLlmStatus(); },
    );
  }, [refreshLlmStatus]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void fetchLlmStatus().then((status) => {
      if (cancelled) return;
      setLlmStatus(status);
      if (status.download.downloading) unsub = watchLlmDownload();
    }).catch(() => {});
    return () => { cancelled = true; unsub?.(); };
  }, [watchLlmDownload]);

  // Poll always: the model can be turned on, downloaded or moved from Settings while this page stays open, and
  // sleeping / loaded transitions happen on their own.
  useEffect(() => {
    const id = setInterval(() => { void refreshLlmStatus(); }, 3000);
    return () => clearInterval(id);
  }, [refreshLlmStatus]);

  useEffect(() => {
    if (!settingsOpen) void refreshLlmStatus();
  }, [settingsOpen, refreshLlmStatus]);

  const handleLlmRetry = async () => {
    try {
      setLlmStatus(await retryLlmDownload());
      watchLlmDownload();
    } catch (err) {
      setLlmTestError((err as Error).message || 'Could not start the download.');
    }
  };

  const handleLlmTest = async () => {
    setLlmTesting(true);
    setLlmTestError(null);
    setLlmTest(null);
    try {
      const result = await testLlm();
      setLlmTest({ reply: result.reply, totalMs: result.totalMs });
    } catch (err) {
      setLlmTestError((err as Error).message || 'The local language model did not respond.');
    } finally {
      setLlmTesting(false);
      void refreshLlmStatus();
    }
  };

  const setupCommand = isMac
    ? 'brew install whisper-cpp ffmpeg'
    : 'powershell -ExecutionPolicy Bypass -File scripts\\setup-whisper.ps1';
  // Bundled ffmpeg (AUG-115): npm run setup downloads it next to whisper-cli; a manual install is only the fallback.
  const ffmpegSetupCommand = 'npm run setup';
  const ffmpegManualCommand = isMac ? 'brew install ffmpeg' : 'winget install ffmpeg';
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

  // Poll health while GPU backend probe is in progress
  useEffect(() => {
    if (health.gpuBackend !== 'unknown') return;
    const id = setInterval(() => { void onRefresh(); }, 2000);
    return () => clearInterval(id);
  }, [health.gpuBackend, onRefresh]);

  // Stream CUDA download progress whenever the server reports a download (button-triggered or started at launch
  // because the installer chose GPU), and refresh health when it settles.
  useEffect(() => {
    if (health.cudaStatus !== 'downloading') return;
    const es = new EventSource(CUDA_PROGRESS_URL);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setCudaProgress(data.percent ?? 0);
        if (data.state === 'present') {
          es.close();
          setCudaProgress(100);
          setSwitchedToGpu(true);
          void onRefresh();
        } else if (data.state === 'missing' && data.error) {
          es.close();
          setCudaError(data.error);
          void onRefresh();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); void onRefresh(); };
    return () => es.close();
  }, [health.cudaStatus, onRefresh]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(setupCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  };

  const handleCopyFfmpeg = async () => {
    try {
      await navigator.clipboard.writeText(ffmpegSetupCommand);
      setFfmpegCopied(true);
      setTimeout(() => setFfmpegCopied(false), 2000);
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

  const handleGpuSwitch = async () => {
    setEngineSwitching(true);
    setCudaError(null);
    setCudaProgress(0);
    try {
      const result = await switchEngine('cuda');
      if (result.cudaStatus !== 'downloading') setSwitchedToGpu(true);
      await onRefresh();
    } catch (err) {
      setCudaError((err as Error).message || 'Failed to switch engine');
    } finally {
      setEngineSwitching(false);
    }
  };

  const isDownloading = modelStatus?.state === 'downloading';

  const whisperReady = health.whisperAvailable;
  const modelReady = health.modelAvailable && (!modelStatus || modelStatus.state !== 'downloading');
  const ffmpegReady = health.ffmpegAvailable;
  const allReady = whisperReady && modelReady && ffmpegReady;
  // Windows + NVIDIA states (AUG-137/140). "active" is driven by the real backend (/api/health gpuBackend), never by
  // the selected engine alone: engine=cuda with backend=cpu means the GPU could not be used.
  const nvidia = !isMac && !!health.nvidiaGpu?.detected;
  const engineCuda = health.gpuEngine === 'cuda' || switchedToGpu;
  const cudaInstalled = health.cudaStatus === 'present' || health.cudaStatus === 'not-needed';
  const cudaDownloading = health.cudaStatus === 'downloading' || engineSwitching;
  const showCudaDownload = nvidia && cudaDownloading;
  const showGpuSwitch = nvidia && !cudaDownloading && (!engineCuda || health.cudaStatus === 'missing');
  const showGpuReady = nvidia && engineCuda && cudaInstalled && health.gpuBackend === 'cuda';
  const showGpuStarting = nvidia && engineCuda && cudaInstalled && health.gpuBackend === 'unknown';
  const showGpuFallback = nvidia && engineCuda && cudaInstalled && health.gpuBackend === 'cpu';

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
        {allReady && !nvidia && health.gpuBackend && health.gpuBackend !== 'cpu' && (
          <p className="diag-info-line diag-gpu-status">
            {health.gpuBackend === 'unknown'
              ? 'GPU: detecting…'
              : `GPU acceleration: ${health.gpuBackend === 'vulkan' ? 'Vulkan' : health.gpuBackend === 'cuda' ? 'CUDA (NVIDIA)' : 'Metal'}`}
          </p>
        )}

        {showGpuReady && (
          <div className="diag-gpu-ready">
            <svg className="diag-gpu-icon" viewBox="0 0 16 16" fill="none" stroke="#00c876" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="12" height="8" />
              <line x1="6" y1="12" x2="6" y2="14" />
              <line x1="10" y1="12" x2="10" y2="14" />
              <line x1="4" y1="14" x2="12" y2="14" />
              <rect x="5" y="6" width="6" height="4" opacity="0.4" />
            </svg>
            <span>GPU (NVIDIA) — active</span>
          </div>
        )}

        {showGpuStarting && (
          <p className="diag-info-line diag-gpu-status">GPU (NVIDIA) — starting…</p>
        )}

        {showGpuFallback && (
          <div className="diag-gpu-switch">
            <p className="diag-info-line diag-cpu-notice">
              GPU (NVIDIA) could not be used — transcription runs on CPU.
            </p>
            {!health.gpuEnginePinned && (
              <button className="diag-gpu-switch-btn" onClick={handleGpuSwitch} type="button">
                Retry GPU engine (NVIDIA)
              </button>
            )}
            {cudaError && (
              <p className="diag-info-line diag-gpu-error">{cudaError}</p>
            )}
          </div>
        )}

        {!nvidia && health.gpuBackend === 'cpu' && (
          <p className="diag-info-line diag-cpu-notice">
            Transcription runs on CPU — processing will take longer.
          </p>
        )}

        {showCudaDownload && (
          <div className="diag-gpu-switch">
            <p className="diag-info-line diag-cpu-notice">
              Transcription runs on CPU — processing will take longer.
            </p>
            {health.cudaStatus === 'downloading' ? (
              <div className="diag-section">
                <div className="diag-progress">
                  <div className="diag-progress-track">
                    <div className="diag-progress-fill" style={{ width: `${cudaProgress}%` }} />
                  </div>
                  <div className="diag-progress-text">
                    Installing GPU engine… {cudaProgress.toFixed(0)}%
                  </div>
                </div>
              </div>
            ) : (
              <button className="diag-gpu-switch-btn" disabled type="button">Switching…</button>
            )}
          </div>
        )}

        {showGpuSwitch && (
          <div className="diag-gpu-switch">
            <p className="diag-info-line diag-cpu-notice">
              Transcription runs on CPU — processing will take longer.
            </p>
            {health.gpuEnginePinned ? (
              <p className="diag-info-line diag-gpu-pinned">Engine is set by system configuration.</p>
            ) : (
              <button className="diag-gpu-switch-btn" onClick={handleGpuSwitch} type="button">
                {health.cudaStatus === 'missing' ? 'Install GPU engine (NVIDIA)' : 'Switch to GPU (NVIDIA)'}
              </button>
            )}
            {cudaError ? (
              <p className="diag-info-line diag-gpu-error">{cudaError}</p>
            ) : health.cudaStatus === 'missing' && engineCuda ? (
              <p className="diag-info-line diag-gpu-error">The GPU engine is not installed yet.</p>
            ) : null}
          </div>
        )}

        {(() => {
          // ok = green, warn = yellow (installed but off), progress = pulsing yellow, danger = red (not installed / broken).
          type Tone = 'ok' | 'warn' | 'progress' | 'danger' | 'muted';
          const nodeState = llmNodeState(llmStatus);
          const folderMissing = llmStatus?.enabled === true && llmStatus.location.available === false && nodeState !== 'downloading';
          const llmPercent = (llmStatus?.download.percent ?? 0).toFixed(1);
          const llmRow: { tone: Tone; text: string } = folderMissing
            ? { tone: 'danger', text: 'Folder not available' }
            : ({
                off: llmStatus?.install === 'ready'
                  ? { tone: 'warn', text: 'Installed, off' }
                  : { tone: 'danger', text: 'Not installed' },
                missing: { tone: 'danger', text: 'Not downloaded' },
                downloading: {
                  tone: 'progress',
                  text: llmStatus?.download.phase === 'moving' ? `Moving files — ${llmPercent}%` : `Downloading — ${llmPercent}%`,
                },
                waking: { tone: 'progress', text: 'Waking up…' },
                sleeping: { tone: 'ok', text: 'Downloaded, sleeping' },
                loaded: { tone: 'ok', text: 'Loaded in memory' },
              } as Record<typeof nodeState, { tone: Tone; text: string }>)[nodeState];
          const rows: { key: string; label: string; optional?: boolean; hint: string; tone: Tone; text: string }[] = [
            {
              key: 'whisper',
              label: 'Whisper Engine',
              hint: 'Local speech-to-text engine built from whisper.cpp with GPU acceleration.',
              tone: whisperReady ? 'ok' : 'danger',
              text: whisperReady ? 'Operational' : 'Not installed',
            },
            {
              key: 'ggml',
              label: 'GGML Model',
              hint: 'Neural network weights (~874 MB). Required for the whisper engine to transcribe audio.',
              tone: modelReady ? 'ok' : isDownloading ? 'progress' : 'danger',
              text: modelReady
                ? 'Operational'
                : isDownloading
                  ? `Downloading — ${modelStatus!.percent.toFixed(1)}%`
                  : 'Not downloaded (~874 MB)',
            },
            {
              key: 'ffmpeg',
              label: 'FFmpeg',
              hint: 'Converts browser audio (WebM) to WAV for the whisper engine. Required for recording.',
              tone: ffmpegReady ? 'ok' : 'danger',
              text: ffmpegReady ? 'Available' : 'Not installed',
            },
            {
              key: 'llm',
              label: 'Language Model',
              optional: true,
              hint: 'Optional local model for meaning-based text checks. Turned on in Settings → Transcription. Starts on demand and unloads when idle.',
              ...llmRow,
            },
          ];
          return (
            <table className="diag-table">
              <thead>
                <tr><th scope="col">Service</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className={`diag-row--${r.tone}`}>
                    <th scope="row" className="diag-table-service">
                      {r.label}
                      {r.optional && <span className="diag-tag-optional">optional</span>}
                      <HintPopup text={r.hint} />
                    </th>
                    <td className="diag-table-status">
                      <span className={`diag-status diag-status--${r.tone}`}>{r.text}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })()}

        {/* FFmpeg guidance — shown when whisper+model are ready but ffmpeg is missing. Bundled setup first, manual install as fallback. */}
        {!ffmpegReady && whisperReady && modelReady && (
          <div className="diag-section">
            <div className="diag-section-title">Install FFmpeg</div>
            <p className="diag-section-desc">
              FFmpeg converts browser audio (WebM) to WAV for the whisper engine. Run this at the project root — it downloads a bundled FFmpeg next to whisper-cli:
            </p>
            <div className="diag-code-block">
              <code className="diag-code-text">{ffmpegSetupCommand}</code>
              <button className="diag-code-copy" onClick={handleCopyFfmpeg} type="button" title="Copy command">
                {ffmpegCopied ? (
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
            <p className="diag-section-desc">
              Fallback if setup cannot download it: {ffmpegManualCommand}
            </p>
          </div>
        )}

        {/* Language Model (optional, AUG-162) — full section when on; description + Turn on (opens Settings) when off */}
        {llmStatus && !llmStatus.enabled && (
          <div className="diag-section">
            <div className="diag-section-title">Language Model</div>
            <p className="diag-section-desc">Optional local model for meaning-based text checks. It is off — nothing is downloaded.</p>
            <button className="diag-gpu-switch-btn" type="button" onClick={onOpenLlmSettings}>Turn on…</button>
          </div>
        )}
        {llmStatus?.enabled && (
          <div className="diag-section">
            <div className="diag-section-title">Language Model</div>
            {llmStatus.download.downloading && (
              <div className="diag-progress">
                <div className="diag-progress-track">
                  <div className="diag-progress-fill" style={{ width: `${llmStatus.download.percent}%` }} />
                </div>
                <div className="diag-progress-text">
                  {llmStatus.download.verifying
                    ? 'Verifying checksum...'
                    : llmStatus.download.phase === 'moving'
                      ? `Moving model files… ${llmStatus.download.percent.toFixed(1)}%`
                      : `${formatBytes(llmStatus.download.bytesDownloaded)} / ${formatBytes(llmStatus.download.totalBytes)} — ${llmStatus.download.percent.toFixed(1)}%`}
                </div>
              </div>
            )}
            {!llmStatus.download.downloading && !llmStatus.download.error && !llmStatus.location.available && (
              <div className="diag-error">The model folder is not available. Connect the drive or choose another folder.</div>
            )}
            {!llmStatus.download.downloading && llmStatus.download.error && (
              <>
                <div className="diag-error">{llmStatus.download.error}</div>
                <button className="diag-gpu-switch-btn" type="button" onClick={() => void handleLlmRetry()}>Retry download</button>
              </>
            )}
            {!llmStatus.download.downloading && llmStatus.install === 'ready' && (
              <>
                <button className="diag-gpu-switch-btn" type="button" disabled={llmTesting} onClick={() => void handleLlmTest()}>
                  {llmTesting ? 'Testing…' : 'Test'}
                </button>
                {llmTest && (
                  <>
                    <p className="diag-info-line diag-gpu-status">Reply: {'“'}{llmTest.reply}{'”'}</p>
                    <p className="diag-info-line">Answered in {(llmTest.totalMs / 1000).toFixed(1)} s</p>
                  </>
                )}
                {llmTestError && <p className="diag-info-line diag-gpu-error">{llmTestError}</p>}
              </>
            )}
          </div>
        )}

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
