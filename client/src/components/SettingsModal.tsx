import React, { useEffect, useRef, useState } from 'react';
import type { UserPreferences } from '../services/preferences';
import { DEFAULT_PREFERENCES, isSystemCaptureUsable, resolveSystemAudioSource } from '../services/preferences';
import { compactPrefs } from '../services/compact';
import { switchEngine, CUDA_PROGRESS_URL, fetchLlmModels, fetchLlmStatus, enableLlm, disableLlm, retryLlmDownload, browseLlmFolder, setLlmLocation, fetchGroqTextStatus, enableGroqText, disableGroqText } from '../api';
import type { CaptureCapabilities, GroqTextStatus, HealthStatus, LlmModelId, LlmModelInfo, LlmStatus, SystemAudioSource } from '../types';
import { formatGb, formatRamGb, qualityLabel, subscribeLlmProgress } from '../services/llm';
import type { DesktopSettings } from '../desktop';
import { acceleratorFromKeyboardEvent, formatAccelerator } from '../services/desktop';
import SettingsDropdown from './SettingsDropdown';
import PraxisProjectsPage from './PraxisProjectsPage';
import GroqKeyModal from './GroqKeyModal';
import GroqTextConsentModal from './GroqTextConsentModal';

interface SettingsModalProps {
  preferences: UserPreferences;
  audioDevices: MediaDeviceInfo[];
  captureCapabilities: CaptureCapabilities | null;
  onPreferenceChange: (patch: Partial<UserPreferences>) => void;
  onReset: () => void;
  onClose: () => void;
  gpuBackend?: HealthStatus['gpuBackend'];
  gpuEngine?: HealthStatus['gpuEngine'];
  nvidiaGpu?: HealthStatus['nvidiaGpu'];
  cudaStatus?: HealthStatus['cudaStatus'];
  onHealthRefresh: () => void;
  isTranscribing: boolean;
  groqAvailable: boolean;
  onGroqKeySaved: () => void;
  initialTab?: 'general' | 'audio' | 'transcription' | 'projects' | 'compact';
}

const SettingsModal: React.FC<SettingsModalProps> = ({
  preferences,
  audioDevices,
  captureCapabilities,
  onPreferenceChange,
  onReset,
  onClose,
  gpuBackend,
  gpuEngine,
  nvidiaGpu,
  cudaStatus,
  onHealthRefresh,
  isTranscribing,
  groqAvailable,
  onGroqKeySaved,
  initialTab,
}) => {
  const [engineSwitching, setEngineSwitching] = useState(false);
  const [cudaProgress, setCudaProgress] = useState<number>(0);
  const [cudaError, setCudaError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [tab, setTab] = useState<'general' | 'audio' | 'transcription' | 'projects' | 'compact'>(initialTab ?? 'general');

  // Opt-in local language model (AUG-162). Nothing is downloaded until the user confirms.
  const [llmModels, setLlmModels] = useState<LlmModelInfo[]>([]);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [llmSelected, setLlmSelected] = useState<LlmModelId>('qwen2.5-1.5b-instruct-q4km');
  const [llmConfirm, setLlmConfirm] = useState<LlmModelId | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const llmUnsubRef = useRef<(() => void) | null>(null);

  const watchLlmProgress = () => {
    llmUnsubRef.current?.();
    llmUnsubRef.current = subscribeLlmProgress(
      (download) => setLlmStatus((prev) => (prev ? { ...prev, download } : prev)),
      () => { void fetchLlmStatus().then(setLlmStatus).catch(() => {}); },
    );
  };

  useEffect(() => {
    if (tab !== 'transcription') return;
    let cancelled = false;
    void fetchLlmModels().then((models) => { if (!cancelled) setLlmModels(models); }).catch(() => {});
    void fetchLlmStatus().then((status) => {
      if (cancelled) return;
      setLlmStatus(status);
      setLlmSelected(status.modelId);
      if (status.download.downloading) watchLlmProgress();
    }).catch(() => {});
    return () => {
      cancelled = true;
      llmUnsubRef.current?.();
      llmUnsubRef.current = null;
    };
  }, [tab]);

  const runLlmAction = async (action: () => Promise<LlmStatus>, watch: boolean) => {
    setLlmBusy(true);
    setLlmError(null);
    try {
      const status = await action();
      setLlmStatus(status);
      if (watch) watchLlmProgress();
    } catch (err) {
      setLlmError((err as Error).message || 'Something went wrong.');
    } finally {
      setLlmBusy(false);
    }
  };

  // Opt-in online text correction via Groq (AUG-164). Off until the user accepts the consent.
  const [groqText, setGroqText] = useState<GroqTextStatus | null>(null);
  const [groqConsentOpen, setGroqConsentOpen] = useState(false);
  const [groqKeyOpen, setGroqKeyOpen] = useState(false);
  const [groqTextBusy, setGroqTextBusy] = useState(false);
  const [groqTextError, setGroqTextError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchGroqTextStatus().then((status) => { if (!cancelled) setGroqText(status); }).catch(() => {});
    return () => { cancelled = true; };
  }, [groqAvailable]);

  // Desktop shell (Electron) settings — the section renders only when window.august exists.
  const desktop = window.august ?? null;
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(null);
  const [hotkeyCapturing, setHotkeyCapturing] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    desktop.getSettings().then(setDesktopSettings).catch(() => {});
  }, [desktop]);

  const applyHotkey = async (accelerator: string | null) => {
    if (!desktop) return;
    setHotkeyError(null);
    try {
      const result = await desktop.setRecordHotkey(accelerator);
      setDesktopSettings((prev) => (prev
        ? { ...prev, recordHotkey: result.recordHotkey, hotkeyRegistered: result.ok && result.recordHotkey !== null }
        : prev));
      if (!result.ok) setHotkeyError(result.error ?? 'Could not register this shortcut.');
    } catch (err) {
      setHotkeyError((err as Error).message || 'Could not register this shortcut.');
    }
  };

  const handleHotkeyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!hotkeyCapturing) return;
    e.preventDefault();
    e.stopPropagation(); // keep Escape from closing the modal while capturing
    if (e.key === 'Escape') {
      setHotkeyCapturing(false);
      e.currentTarget.blur();
      return;
    }
    const accelerator = acceleratorFromKeyboardEvent(e.nativeEvent);
    if (!accelerator) return; // modifier-only press — keep waiting
    setHotkeyCapturing(false);
    e.currentTarget.blur();
    void applyHotkey(accelerator);
  };

  const hotkeyDisplay = desktopSettings?.recordHotkey
    ? formatAccelerator(desktopSettings.recordHotkey, desktop?.platform ?? '')
    : 'Disabled';
  const hotkeyWarning = hotkeyError
    ?? (desktopSettings && desktopSettings.recordHotkey && !desktopSettings.hotkeyRegistered
      ? 'This shortcut could not be registered — another application may already use it.'
      : null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !groqConsentOpen && !groqKeyOpen) onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose, groqConsentOpen, groqKeyOpen]);

  const language = preferences.language ?? DEFAULT_PREFERENCES.language;
  const micDeviceId = preferences.micDeviceId ?? DEFAULT_PREFERENCES.micDeviceId;
  const systemAudio = preferences.systemAudio ?? DEFAULT_PREFERENCES.systemAudio;
  const systemAudioSource = preferences.systemAudioSource ?? DEFAULT_PREFERENCES.systemAudioSource;
  const systemCaptureAvailable = isSystemCaptureUsable(captureCapabilities);
  // Settings shows no probe internals (capture method, dB levels, stderr) —
  // those stay in the server log and `npm run capture:check`. The user sees
  // only two plain-language states: direct capture is unavailable here, or a
  // Windows reminder to test the capture before an important call. The reminder
  // keys off the chosen source, not the System Audio toggle, so a user who picks
  // System (direct) sees it even before switching system audio on.
  const resolvedSystemSource = resolveSystemAudioSource(systemAudioSource, captureCapabilities);
  const captureHint = captureCapabilities === null
    ? null
    : !systemCaptureAvailable
      ? { text: 'System (direct) is not available on this computer — recordings use the browser screen picker.', warn: false }
      : captureCapabilities.platform === 'win32' && resolvedSystemSource === 'system'
        ? { text: 'Direct system capture on Windows depends on your audio devices and drivers. Make a short test recording and check that the other side was captured before an important call.', warn: true }
        : null;
  const recordingMode = preferences.recordingMode ?? DEFAULT_PREFERENCES.recordingMode;
  const liveEngine = preferences.liveEngine ?? DEFAULT_PREFERENCES.liveEngine;
  const audioBoost = preferences.audioBoost ?? DEFAULT_PREFERENCES.audioBoost;
  const retranscriptionLanguage = preferences.retranscriptionLanguage ?? DEFAULT_PREFERENCES.retranscriptionLanguage;
  const sidebarCollapsed = preferences.sidebarCollapsed ?? DEFAULT_PREFERENCES.sidebarCollapsed;
  const sessionSortOrder = preferences.sessionSortOrder ?? DEFAULT_PREFERENCES.sessionSortOrder;
  const skipStopConfirmation = preferences.skipStopConfirmation ?? DEFAULT_PREFERENCES.skipStopConfirmation;
  const skipClearConfirmation = preferences.skipClearConfirmation ?? DEFAULT_PREFERENCES.skipClearConfirmation;
  const autoDeleteWav = preferences.autoDeleteWav ?? DEFAULT_PREFERENCES.autoDeleteWav;
  const autoDeleteWavThreshold = preferences.autoDeleteWavThreshold ?? DEFAULT_PREFERENCES.autoDeleteWavThreshold;
  const llmCorrections = preferences.llmCorrections ?? DEFAULT_PREFERENCES.llmCorrections;
  const batchCorrectionEngine = preferences.batchCorrectionEngine ?? DEFAULT_PREFERENCES.batchCorrectionEngine;
  const [thresholdDraft, setThresholdDraft] = useState<number>(autoDeleteWavThreshold);
  useEffect(() => { setThresholdDraft(autoDeleteWavThreshold); }, [autoDeleteWavThreshold]);
  const commitThreshold = () => { if (thresholdDraft !== autoDeleteWavThreshold) onPreferenceChange({ autoDeleteWavThreshold: thresholdDraft }); };

  // Compact mode tab (AUG-156): desktop-only; everything is locked in the browser build or while the master toggle is off.
  const compactSupported = Boolean(desktop?.setCompactMode);
  const cp = compactPrefs(preferences);
  const compactLocked = !compactSupported || !cp.enabled;
  const [stripDraft, setStripDraft] = useState<number>(cp.stripWidth);
  useEffect(() => { setStripDraft(cp.stripWidth); }, [cp.stripWidth]);
  const commitStrip = () => { if (stripDraft !== cp.stripWidth) onPreferenceChange({ compactStripWidth: stripDraft }); };

  const handleReset = () => {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    setConfirmingReset(false);
    onReset();
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className={`settings-card${tab === 'projects' ? ' settings-card--projects' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>
        <nav className="settings-tabs" aria-label="Settings sections">
          {(['general', 'audio', 'transcription', 'projects', 'compact'] as const).map((t) => (
            <button key={t} type="button" className={`settings-tab${tab === t ? ' settings-tab--active' : ''}`} onClick={() => setTab(t)}>
              {t === 'general' ? 'General' : t === 'audio' ? 'Audio' : t === 'transcription' ? 'Transcription' : t === 'projects' ? 'Projects' : 'Compact mode'}
            </button>
          ))}
        </nav>
        <div className={`settings-body${tab === 'projects' ? ' settings-body--projects' : ''}`}>
          {tab === 'audio' && (
          <div className="settings-section">
            <div className="settings-section-title">Recording</div>
            <div className="settings-row">
              <label className="settings-label">Language</label>
              <SettingsDropdown
                value={language}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'en', label: 'EN' },
                  { value: 'ru', label: 'RU' },
                ]}
                onChange={(v) => onPreferenceChange({ language: v })}
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">Mic Device</label>
              <SettingsDropdown
                className="settings-dropdown--wide"
                value={micDeviceId}
                options={[
                  { value: 'default', label: 'Default' },
                  ...(audioDevices.length === 0
                    ? [{ value: '', label: 'No devices found', disabled: true }]
                    : audioDevices.map((d) => ({
                        value: d.deviceId,
                        label: d.label || d.deviceId,
                      }))),
                ]}
                onChange={(v) => onPreferenceChange({ micDeviceId: v })}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">System Audio</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={systemAudio}
                  onChange={(e) => onPreferenceChange({ systemAudio: e.target.checked })}
                />
                <span className="settings-toggle-label">{systemAudio ? 'On' : 'Off'}</span>
              </label>
            </div>
            <div className="settings-row">
              <label className="settings-label">System Audio Source</label>
              <SettingsDropdown
                className="settings-dropdown--wide"
                value={systemAudioSource}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'browser', label: 'Browser (screen picker)' },
                  { value: 'system', label: 'System (direct)', disabled: !systemCaptureAvailable },
                ]}
                onChange={(v) => onPreferenceChange({ systemAudioSource: v as SystemAudioSource })}
              />
            </div>
            {captureHint && (
              <div className={`settings-hint${captureHint.warn ? ' settings-hint--warn' : ''}`}>{captureHint.text}</div>
            )}
            <div className="settings-row">
              <label className="settings-label">Recording Mode</label>
              <SettingsDropdown
                value={recordingMode}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'live', label: 'Live' },
                ]}
                onChange={(v) => onPreferenceChange({ recordingMode: v as UserPreferences['recordingMode'] })}
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">Live Engine</label>
              <SettingsDropdown
                value={liveEngine}
                options={[
                  { value: 'local', label: 'Local' },
                  { value: 'groq', label: 'Groq' },
                ]}
                onChange={(v) => onPreferenceChange({ liveEngine: v as UserPreferences['liveEngine'] })}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">Audio Boost</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={audioBoost}
                  onChange={(e) => onPreferenceChange({ audioBoost: e.target.checked })}
                />
                <span className="settings-toggle-label">{audioBoost ? 'On' : 'Off'}</span>
              </label>
            </div>
          </div>
          )}

          {tab === 'transcription' && (
          <div className="settings-section">
            <div className="settings-section-title">Transcription</div>
            <div className="settings-row">
              <label className="settings-label">Retranscription Language</label>
              <SettingsDropdown
                value={retranscriptionLanguage ?? ''}
                options={[
                  { value: '', label: 'None' },
                  { value: 'auto', label: 'Auto' },
                  { value: 'en', label: 'EN' },
                  { value: 'ru', label: 'RU' },
                ]}
                onChange={(v) => onPreferenceChange({ retranscriptionLanguage: v || null })}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">Delete audio.wav after transcription</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={autoDeleteWav}
                  onChange={(e) => onPreferenceChange({ autoDeleteWav: e.target.checked })}
                />
                <span className="settings-toggle-label">{autoDeleteWav ? 'On' : 'Off'}</span>
              </label>
            </div>
            {autoDeleteWav && (
              <div className="settings-row">
                <label className="settings-label" htmlFor="settings-autodelete-threshold">Minimum confidence</label>
                <div className="settings-slider">
                  <input
                    id="settings-autodelete-threshold"
                    type="range"
                    min={50}
                    max={95}
                    step={5}
                    value={thresholdDraft}
                    onChange={(e) => setThresholdDraft(Number(e.target.value))}
                    onMouseUp={commitThreshold}
                    onTouchEnd={commitThreshold}
                    onKeyUp={commitThreshold}
                    onBlur={commitThreshold}
                    aria-valuetext={`${thresholdDraft}%`}
                  />
                  <span className="settings-slider-value">{thresholdDraft}%</span>
                </div>
              </div>
            )}
            <div className="settings-hint">
              {autoDeleteWav
                ? 'Removes only the converted WAV once the confidence score reaches the threshold. The original recording or upload stays, so you can always re-transcribe.'
                : 'Frees disk space after confident transcriptions. The original recording or upload is never removed.'}
            </div>
            {nvidiaGpu?.detected ? (() => {
              const currentEngine = gpuEngine ?? 'cpu';
              const isDownloading = cudaStatus === 'downloading';
              const handleEngineChange = async (v: string) => {
                if (v === currentEngine || engineSwitching || isTranscribing) return;
                setEngineSwitching(true);
                setCudaError(null);
                try {
                  const result = await switchEngine(v as 'cpu' | 'cuda');
                  if (v === 'cuda' && result.cudaStatus === 'downloading') {
                    const evtSource = new EventSource(CUDA_PROGRESS_URL);
                    evtSource.onmessage = (event) => {
                      try {
                        const data = JSON.parse(event.data);
                        setCudaProgress(data.percent ?? 0);
                        if (data.state === 'present') {
                          evtSource.close();
                          setCudaProgress(100);
                          onHealthRefresh();
                        } else if (data.state === 'missing' && data.error) {
                          evtSource.close();
                          setCudaError(data.error);
                        }
                      } catch {}
                    };
                    evtSource.onerror = () => {
                      evtSource.close();
                    };
                  }
                  onHealthRefresh();
                } catch (err) {
                  setCudaError((err as Error).message || 'Failed to switch engine');
                } finally {
                  setEngineSwitching(false);
                }
              };
              return (
                <>
                  <div className="settings-row">
                    <label className="settings-label">Engine</label>
                    <SettingsDropdown
                      value={currentEngine}
                      options={[
                        { value: 'cpu', label: 'CPU' },
                        { value: 'cuda', label: 'GPU (NVIDIA)', disabled: isTranscribing },
                      ]}
                      onChange={(v) => void handleEngineChange(v)}
                    />
                  </div>
                  {isDownloading && (
                    <div className="settings-cuda-progress">
                      <div className="settings-cuda-progress-bar">
                        <div className="settings-cuda-progress-fill" style={{ width: `${cudaProgress}%` }} />
                      </div>
                      <span className="settings-cuda-progress-text">Installing GPU engine... {cudaProgress.toFixed(0)}%</span>
                    </div>
                  )}
                  {cudaError && (
                    <div className="settings-hint settings-hint--warn">{cudaError}</div>
                  )}
                  {currentEngine === 'cpu' && !isDownloading && !cudaError && (
                    <div className="settings-hint settings-hint--warn">Your computer has an NVIDIA GPU. Switch to GPU for faster transcription.</div>
                  )}
                  {currentEngine === 'cuda' && (cudaStatus === 'present' || cudaStatus === 'not-needed') && gpuBackend === 'cuda' && (
                    <div className={`settings-engine-status settings-engine-status--gpu`}>
                      <svg className="engine-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="4" width="12" height="8" />
                        <line x1="6" y1="12" x2="6" y2="14" />
                        <line x1="10" y1="12" x2="10" y2="14" />
                        <line x1="4" y1="14" x2="12" y2="14" />
                        <rect x="5" y="6" width="6" height="4" opacity="0.4" />
                      </svg>
                      <div className="engine-text">
                        <span className="engine-title">Transcription runs on GPU</span>
                        <span className="engine-detail">{isTranscribing ? 'Currently transcribing with hardware acceleration.' : 'Faster processing with hardware acceleration.'}</span>
                      </div>
                    </div>
                  )}
                  {currentEngine === 'cuda' && (cudaStatus === 'present' || cudaStatus === 'not-needed') && gpuBackend === 'cpu' && (
                    <div className="settings-hint settings-hint--warn">GPU (NVIDIA) could not be used — transcription runs on CPU. Open Diagnostics to retry.</div>
                  )}
                </>
              );
            })() : gpuBackend && gpuBackend !== 'unknown' && (() => {
              const isGpu = gpuBackend !== 'cpu';
              const stateClass = isGpu ? 'settings-engine-status--gpu' : 'settings-engine-status--cpu-fallback';
              const title = isGpu ? 'Transcription runs on GPU' : 'Transcription runs on CPU';
              const detail = isGpu
                ? (isTranscribing ? 'Currently transcribing with hardware acceleration.' : 'Faster processing with hardware acceleration.')
                : (isTranscribing
                    ? 'Currently transcribing \u2014 GPU is not available, transcription takes longer.'
                    : 'GPU is not available on this computer \u2014 transcription will take longer than usual.');
              return (
                <div className={`settings-engine-status ${stateClass}`}>
                  <svg className="engine-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {isGpu ? (
                      <>
                        <rect x="2" y="4" width="12" height="8" />
                        <line x1="6" y1="12" x2="6" y2="14" />
                        <line x1="10" y1="12" x2="10" y2="14" />
                        <line x1="4" y1="14" x2="12" y2="14" />
                        <rect x="5" y="6" width="6" height="4" opacity="0.4" />
                      </>
                    ) : (
                      <>
                        <rect x="3" y="5" width="10" height="7" />
                        <line x1="1" y1="8.5" x2="3" y2="8.5" />
                        <line x1="13" y1="7" x2="15" y2="7" />
                        <line x1="13" y1="10" x2="15" y2="10" />
                      </>
                    )}
                  </svg>
                  <div className="engine-text">
                    <span className="engine-title">{title}</span>
                    <span className="engine-detail">{detail}</span>
                  </div>
                </div>
              );
            })()}
            {llmStatus?.supported && llmModels.length > 0 && (() => {
              const selected = llmModels.find((m) => m.id === llmSelected) ?? llmModels[0];
              const download = llmStatus.download;
              const confirmModel = llmModels.find((m) => m.id === llmConfirm) ?? null;
              const location = llmStatus.location;
              const lowSpace = !!confirmModel && location.freeBytes !== null && location.freeBytes < confirmModel.diskBytes + 200e6;
              const folderLocked = llmBusy || download.downloading || llmConfirm !== null;
              const phaseText = download.verifying
                ? 'Verifying…'
                : download.phase === 'moving'
                  ? `Moving model files… ${download.percent.toFixed(0)}%`
                  : download.phase === 'model'
                  ? `Downloading local model… ${download.percent.toFixed(0)}%`
                  : `Downloading model engine… ${download.percent.toFixed(0)}%`;
              const toggleOn = llmStatus.enabled || llmConfirm !== null;
              return (
                <>
                  <div className="settings-row">
                    <span className="settings-label">Local language model</span>
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={toggleOn}
                        disabled={llmBusy}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setLlmError(null);
                            setLlmConfirm(llmSelected);
                          } else if (llmConfirm !== null) {
                            setLlmConfirm(null);
                          } else {
                            void runLlmAction(disableLlm, false);
                          }
                        }}
                      />
                      <span className="settings-toggle-label">{toggleOn ? 'On' : 'Off'}</span>
                    </label>
                  </div>
                  {llmStatus.enabled && (
                    <>
                      <div className="settings-row">
                        <span className="settings-label">Allow the model to correct text by meaning</span>
                        <label className="settings-toggle">
                          <input type="checkbox" checked={llmCorrections} onChange={(e) => onPreferenceChange({ llmCorrections: e.target.checked })} />
                          <span className="settings-toggle-label">{llmCorrections ? 'On' : 'Off'}</span>
                        </label>
                      </div>
                      <div className="settings-hint">Suspicious lines get a suggested fix after transcription. The original transcript is never changed — you accept or reject each fix.</div>
                    </>
                  )}
                  <div className="settings-row">
                    <label className="settings-label">Model</label>
                    <SettingsDropdown
                      className="settings-dropdown--wide"
                      value={llmSelected}
                      options={llmModels.map((m) => ({ value: m.id, label: `${m.label} — ${qualityLabel(m.quality)}` }))}
                      onChange={(v) => {
                        const id = v as LlmModelId;
                        setLlmSelected(id);
                        if (llmStatus.enabled && id !== llmStatus.modelId) setLlmConfirm(id);
                      }}
                    />
                  </div>
                  <div className="settings-hint">
                    {`${formatGb(selected.diskBytes)} on disk · about ${formatRamGb(selected.ramBytes)} of memory · quality: ${qualityLabel(selected.quality)}`}
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">Model folder</span>
                    {location.pinned ? null : (
                      <div className="settings-llm-folder-actions">
                        <button
                          type="button"
                          className="settings-llm-btn"
                          disabled={folderLocked}
                          onClick={() => {
                            void (async () => {
                              try {
                                const { path } = await browseLlmFolder();
                                if (path) await runLlmAction(() => setLlmLocation(path), true);
                              } catch (err) {
                                setLlmError((err as Error).message || 'Something went wrong.');
                              }
                            })();
                          }}
                        >
                          Change…
                        </button>
                        {!location.isDefault && (
                          <button
                            type="button"
                            className="settings-llm-btn"
                            disabled={folderLocked}
                            onClick={() => void runLlmAction(() => setLlmLocation(null), true)}
                          >
                            Use default
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="settings-llm-path">{location.root}</div>
                  {!location.available && (
                    <div className="settings-hint settings-hint--warn">The model folder is not available. Connect the drive or choose another folder.</div>
                  )}
                  {location.pinned ? (
                    <div className="settings-hint">Set by system configuration.</div>
                  ) : (
                    <div className="settings-hint">Downloaded files are moved to the new folder. The choice is kept after updates.</div>
                  )}
                  {confirmModel && (
                    <div className="settings-llm-confirm">
                      <div className="settings-llm-confirm-title">Download the local language model?</div>
                      <ol className="settings-llm-confirm-list">
                        <li>{`A) ${confirmModel.label} will be downloaded — ${formatGb(confirmModel.diskBytes)}.`}</li>
                        <li>{`B) While it runs it takes about ${formatRamGb(confirmModel.ramBytes)} of RAM/VRAM. It starts only when needed and unloads after 10 minutes idle.`}</li>
                        <li>{`C) Files are stored in ${location.root}.`}</li>
                        {lowSpace && location.freeBytes !== null && (
                          <li className="settings-llm-warn">{`Not enough free space there (${formatGb(location.freeBytes)} free) — choose another folder first.`}</li>
                        )}
                      </ol>
                      <div className="settings-llm-actions">
                        <button
                          type="button"
                          className="settings-llm-btn settings-llm-btn--primary"
                          disabled={llmBusy || lowSpace}
                          onClick={() => {
                            const id = confirmModel.id;
                            setLlmConfirm(null);
                            void runLlmAction(() => enableLlm(id), true);
                          }}
                        >
                          Download and enable
                        </button>
                        <button type="button" className="settings-llm-btn" onClick={() => setLlmConfirm(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {download.downloading && (
                    <div className="settings-cuda-progress">
                      <div className="settings-cuda-progress-bar">
                        <div className="settings-cuda-progress-fill" style={{ width: `${download.percent}%` }} />
                      </div>
                      <span className="settings-cuda-progress-text">{phaseText}</span>
                    </div>
                  )}
                  {llmStatus.enabled && !download.downloading && download.error && (
                    <>
                      <div className="settings-hint settings-hint--warn">{download.error}</div>
                      <div className="settings-llm-actions">
                        <button type="button" className="settings-llm-btn" disabled={llmBusy} onClick={() => void runLlmAction(retryLlmDownload, true)}>Retry download</button>
                      </div>
                    </>
                  )}
                  {llmError && <div className="settings-hint settings-hint--warn">{llmError}</div>}
                  {llmStatus.enabled && !download.downloading && !download.error && llmStatus.install === 'ready' && (
                    <div className="settings-hint">Ready. Test it from Diagnostics.</div>
                  )}
                </>
              );
            })()}
            {groqText && (
              <>
                <div className="settings-row">
                  <span className="settings-label">Online text correction (Groq)</span>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={groqText.enabled || groqConsentOpen || groqKeyOpen}
                      disabled={groqTextBusy}
                      onChange={(e) => {
                        setGroqTextError(null);
                        if (e.target.checked) { setGroqConsentOpen(true); return; }
                        setGroqTextBusy(true);
                        void disableGroqText().then(setGroqText).catch((err) => setGroqTextError((err as Error).message || 'Something went wrong.')).finally(() => setGroqTextBusy(false));
                      }}
                    />
                    <span className="settings-toggle-label">{groqText.enabled ? 'On' : 'Off'}</span>
                  </label>
                </div>
                <div className="settings-hint">Fixes live transcript lines a few seconds after they appear and collects live action items. After a recording, doubtful lines get a suggested fix to accept or reject; the original transcript is never changed.</div>
                {groqText.enabled && llmStatus?.enabled && llmCorrections && (
                  <div className="settings-row">
                    <label className="settings-label">Fixes after recording by</label>
                    <SettingsDropdown
                      value={batchCorrectionEngine}
                      options={[
                        { value: 'local', label: 'Local model' },
                        { value: 'groq', label: 'Groq' },
                      ]}
                      onChange={(v) => onPreferenceChange({ batchCorrectionEngine: v === 'groq' ? 'groq' : 'local' })}
                    />
                  </div>
                )}
                {groqText.consentStale && <div className="settings-hint settings-hint--warn">The Groq key changed. Turn this on again to confirm.</div>}
                {groqText.enabled && groqText.blocked && (
                  <div className="settings-hint settings-hint--warn">Groq is not reachable from your network, so corrections are skipped. A VPN may help.</div>
                )}
                {groqTextError && !groqConsentOpen && <div className="settings-hint settings-hint--warn">{groqTextError}</div>}
              </>
            )}
          </div>
          )}

          {tab === 'general' && (
          <>
          <div className="settings-section">
            <div className="settings-section-title">Interface</div>
            <div className="settings-row">
              <span className="settings-label">Sidebar Collapsed</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={sidebarCollapsed}
                  onChange={(e) => onPreferenceChange({ sidebarCollapsed: e.target.checked })}
                />
                <span className="settings-toggle-label">{sidebarCollapsed ? 'On' : 'Off'}</span>
              </label>
            </div>
            <div className="settings-row">
              <label className="settings-label">Session Sort Order</label>
              <SettingsDropdown
                value={sessionSortOrder}
                options={[
                  { value: 'newest', label: 'Newest' },
                  { value: 'oldest', label: 'Oldest' },
                  { value: 'alphabetical', label: 'Alphabetical' },
                ]}
                onChange={(v) => onPreferenceChange({ sessionSortOrder: v as UserPreferences['sessionSortOrder'] })}
              />
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Confirmations</div>
            <div className="settings-row">
              <span className="settings-label">Skip Stop Confirmation</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={skipStopConfirmation}
                  onChange={(e) => onPreferenceChange({ skipStopConfirmation: e.target.checked })}
                />
                <span className="settings-toggle-label">{skipStopConfirmation ? 'On' : 'Off'}</span>
              </label>
            </div>
            <div className="settings-row">
              <span className="settings-label">Skip Clear Confirmation</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={skipClearConfirmation}
                  onChange={(e) => onPreferenceChange({ skipClearConfirmation: e.target.checked })}
                />
                <span className="settings-toggle-label">{skipClearConfirmation ? 'On' : 'Off'}</span>
              </label>
            </div>
          </div>

          {desktop && (
            <div className="settings-section">
              <div className="settings-section-title">Desktop</div>
              <div className="settings-row">
                <label className="settings-label">Record Hotkey</label>
                <div className="settings-path-group">
                  <input
                    type="text"
                    readOnly
                    className="settings-control settings-input"
                    value={hotkeyCapturing ? '' : hotkeyDisplay}
                    placeholder={hotkeyCapturing ? 'Press a key combination… (Esc to cancel)' : ''}
                    title="Click, then press the shortcut you want"
                    onFocus={() => setHotkeyCapturing(true)}
                    onBlur={() => setHotkeyCapturing(false)}
                    onKeyDown={handleHotkeyKeyDown}
                  />
                  <button
                    type="button"
                    className="settings-btn-inline"
                    disabled={!desktopSettings}
                    onClick={() => void applyHotkey(desktopSettings?.defaultRecordHotkey ?? null)}
                  >
                    Default
                  </button>
                  {desktopSettings?.recordHotkey && (
                    <button
                      type="button"
                      className="settings-btn-inline settings-btn-inline--danger"
                      onClick={() => void applyHotkey(null)}
                    >
                      Disable
                    </button>
                  )}
                </div>
              </div>
              {hotkeyWarning && <div className="settings-hint settings-hint--warn">{hotkeyWarning}</div>}
              <div className="settings-hint">Starts or stops a recording with your saved defaults from anywhere — even while August sits in the tray.</div>
            </div>
          )}
          </>
          )}

          {tab === 'projects' && (
            <PraxisProjectsPage preferences={preferences} onPreferenceChange={onPreferenceChange} />
          )}

          {tab === 'compact' && (
            <div className="settings-section compact-tab">
              {!compactSupported && (
                <div className="settings-hint settings-hint--warn">Desktop app only — Compact mode needs the August desktop app.</div>
              )}
              <div className="settings-section-title">Compact mode</div>
              <div className="settings-row">
                <span className="settings-label">
                  Enable Compact mode
                  <small className="compact-small">While recording, August shrinks to a widget and comes back when the recording ends.</small>
                </span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={cp.enabled}
                    disabled={!compactSupported}
                    onChange={(e) => onPreferenceChange({ compactEnabled: e.target.checked })}
                  />
                  <span className="settings-toggle-label">{cp.enabled ? 'On' : 'Off'}</span>
                </label>
              </div>
              {compactSupported && !cp.enabled && (
                <div className="compact-locked-note">▲ Turn on Compact mode to edit the options below</div>
              )}

              <div className={`compact-settings${compactLocked ? ' compact-settings--locked' : ''}`}>
                <div className="compact-group">
                  <div className="compact-group-title">Mode <span className="compact-group-hint">what the widget shows</span></div>
                  <div className="compact-radios">
                    {([
                      { value: 'follow', title: 'Follow the recording mode', def: true, desc: 'Default recording → recording indicator. Live transcription → live transcript widget.' },
                      { value: 'indicator', title: 'Always recording indicator', def: false, desc: 'Timer and level only, even during Live transcription. The widget shows a live line counter; the lines themselves keep streaming into the full window.' },
                      { value: 'transcript', title: 'Always live transcript', def: false, desc: 'The transcript widget in both modes. A Default recording automatically starts with Live transcription on (saved engine), so the widget always has lines.' },
                    ] as const).map((o) => (
                      <label key={o.value} className={`compact-radio${cp.mode === o.value ? ' compact-radio--on' : ''}`}>
                        <input type="radio" name="compact-mode" value={o.value} checked={cp.mode === o.value} disabled={compactLocked} onChange={() => onPreferenceChange({ compactMode: o.value })} />
                        <span className="compact-radio-mark" aria-hidden="true" />
                        <span className="compact-radio-text">
                          {o.title}{o.def && <span className="compact-badge">DEFAULT</span>}
                          <small>{o.desc}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="compact-group">
                  <div className="compact-group-title">Recording indicator widget <span className="compact-group-hint">used when the widget shows the indicator</span></div>
                  <div className="compact-cards">
                    <label className={`compact-card${cp.indicatorWidget === 'dock-square' ? ' compact-card--on' : ''}`}>
                      <input type="radio" name="compact-ind" value="dock-square" checked={cp.indicatorWidget === 'dock-square'} disabled={compactLocked} onChange={() => onPreferenceChange({ compactIndicatorWidget: 'dock-square' })} />
                      <span className="compact-card-title">Dock Square <span className="compact-card-variant">VARIANT A</span></span>
                      <span className="compact-sch" aria-hidden="true"><span className="compact-sch-call" style={{ right: '22%' }} /><span className="compact-sch-aug" style={{ right: '4%', bottom: '8%', width: '16%', aspectRatio: '1' }} /><span className="compact-sch-dot" style={{ right: '16%', bottom: '20%' }} /></span>
                      <span className="compact-card-desc">The August window itself shrinks to a 180×180 square: timer, level bars, [ STOP ] on the bottom edge. During Live it also shows the line counter.</span>
                    </label>
                    <label className={`compact-card${cp.indicatorWidget === 'ghost-coin' ? ' compact-card--on' : ''}`}>
                      <input type="radio" name="compact-ind" value="ghost-coin" checked={cp.indicatorWidget === 'ghost-coin'} disabled={compactLocked} onChange={() => onPreferenceChange({ compactIndicatorWidget: 'ghost-coin' })} />
                      <span className="compact-card-title">Ghost Coin <span className="compact-card-variant">VARIANT B</span></span>
                      <span className="compact-sch" aria-hidden="true"><span className="compact-sch-call" style={{ right: '4%' }} /><span className="compact-sch-aug" style={{ right: '6%', bottom: '10%', width: '9%', aspectRatio: '1', background: 'rgba(6,11,8,.9)' }} /><span className="compact-sch-dot" style={{ right: '9.5%', bottom: '16%' }} /></span>
                      <span className="compact-card-desc">August hides to the tray; a 56px always-on-top coin floats over the call and expands on hover. During Live it also shows the line counter.</span>
                    </label>
                  </div>
                </div>

                <div className="compact-group">
                  <div className="compact-group-title">Live transcript widget <span className="compact-group-hint">used when the widget shows the transcript</span></div>
                  <div className="compact-cards">
                    <label className={`compact-card${cp.transcriptWidget === 'dock-strip' ? ' compact-card--on' : ''}`}>
                      <input type="radio" name="compact-tx" value="dock-strip" checked={cp.transcriptWidget === 'dock-strip'} disabled={compactLocked} onChange={() => onPreferenceChange({ compactTranscriptWidget: 'dock-strip' })} />
                      <span className="compact-card-title">Dock Strip <span className="compact-card-variant">VARIANT A</span></span>
                      <span className="compact-sch" aria-hidden="true"><span className="compact-sch-call" style={{ right: '30%' }} /><span className="compact-sch-aug" style={{ right: '4%', top: '6%', bottom: '6%', width: '22%' }} /><span className="compact-sch-line" style={{ right: '7%', top: '30%', width: '16%' }} /><span className="compact-sch-line" style={{ right: '7%', top: '42%', width: '12%', background: '#8a6a2a' }} /><span className="compact-sch-line" style={{ right: '7%', top: '54%', width: '14%' }} /></span>
                      <span className="compact-card-desc">The August window shrinks to a 360px strip on the right edge: last lines, [ PAUSE ] [ END ].</span>
                    </label>
                    <label className={`compact-card${cp.transcriptWidget === 'ghost-caption' ? ' compact-card--on' : ''}`}>
                      <input type="radio" name="compact-tx" value="ghost-caption" checked={cp.transcriptWidget === 'ghost-caption'} disabled={compactLocked} onChange={() => onPreferenceChange({ compactTranscriptWidget: 'ghost-caption' })} />
                      <span className="compact-card-title">Ghost Caption <span className="compact-card-variant">VARIANT B</span></span>
                      <span className="compact-sch" aria-hidden="true"><span className="compact-sch-call" style={{ right: '4%' }} /><span className="compact-sch-aug" style={{ left: '12%', right: '12%', bottom: '12%', height: '22%', background: 'rgba(6,11,8,.85)' }} /><span className="compact-sch-line" style={{ left: '16%', bottom: '24%', width: '40%' }} /><span className="compact-sch-line" style={{ left: '16%', bottom: '17%', width: '30%', background: '#8a6a2a' }} /></span>
                      <span className="compact-card-desc">August hides to the tray; a transparent caption ribbon with the last 3 lines floats over the call.</span>
                    </label>
                  </div>
                </div>

                <div className="compact-more">
                  <div className="compact-group-title compact-group-title--amber">More options</div>
                  <div className="settings-row">
                    <span className="settings-label">
                      Keep on top while compact
                      <small className="compact-small">Variant B needs it; Variant A benefits when the call goes full-screen.</small>
                    </span>
                    <label className="settings-toggle">
                      <input type="checkbox" checked={cp.alwaysOnTop} disabled={compactLocked} onChange={(e) => onPreferenceChange({ compactAlwaysOnTop: e.target.checked })} />
                      <span className="settings-toggle-label">{cp.alwaysOnTop ? 'On' : 'Off'}</span>
                    </label>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">
                      After recording ends
                      <small className="compact-small">Calls usually outlive recordings.</small>
                    </span>
                    <div className="compact-radios compact-radios--small">
                      {([
                        { value: 'stop', label: 'Expand August immediately' },
                        { value: 'click', label: 'Stay compact until I click' },
                      ] as const).map((o) => (
                        <label key={o.value} className={`compact-radio compact-radio--small${cp.expandOn === o.value ? ' compact-radio--on' : ''}`}>
                          <input type="radio" name="compact-after" value={o.value} checked={cp.expandOn === o.value} disabled={compactLocked} onChange={() => onPreferenceChange({ compactExpandOn: o.value })} />
                          <span className="compact-radio-mark" aria-hidden="true" />
                          <span className="compact-radio-text">{o.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <label className="settings-label" htmlFor="settings-compact-strip-width">
                      Dock Strip width
                      <small className="compact-small">Variant A only.</small>
                    </label>
                    <div className="settings-slider">
                      <input
                        id="settings-compact-strip-width"
                        type="range"
                        min={280}
                        max={520}
                        step={20}
                        value={stripDraft}
                        disabled={compactLocked}
                        onChange={(e) => setStripDraft(Number(e.target.value))}
                        onMouseUp={commitStrip}
                        onTouchEnd={commitStrip}
                        onKeyUp={commitStrip}
                        onBlur={commitStrip}
                        aria-valuetext={`${stripDraft} px`}
                      />
                      <span className="settings-slider-value">{stripDraft} px</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="settings-actions">
          <button className="settings-btn settings-btn--danger" onClick={handleReset}>
            {confirmingReset ? 'Are you sure?' : 'Reset to Defaults'}
          </button>
          <button className="settings-btn" onClick={onClose}>Close</button>
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        {groqConsentOpen && !groqKeyOpen && groqText && (
          <GroqTextConsentModal
            groqAvailable={groqText.groqAvailable}
            busy={groqTextBusy}
            error={groqTextError}
            onCancel={() => { setGroqConsentOpen(false); setGroqTextError(null); }}
            onAddKey={() => setGroqKeyOpen(true)}
            onAccept={() => {
              setGroqTextBusy(true);
              setGroqTextError(null);
              void enableGroqText()
                .then((s) => { setGroqText(s); setGroqConsentOpen(false); })
                .catch((err) => setGroqTextError((err as Error).message || 'Something went wrong.'))
                .finally(() => setGroqTextBusy(false));
            }}
          />
        )}
        {groqKeyOpen && (
          <GroqKeyModal
            groqAvailable={groqText?.groqAvailable ?? groqAvailable}
            onClose={() => setGroqKeyOpen(false)}
            onSaved={() => { onGroqKeySaved(); void fetchGroqTextStatus().then(setGroqText).catch(() => {}); }}
          />
        )}
      </div>
    </div>
  );
};

export default SettingsModal;
