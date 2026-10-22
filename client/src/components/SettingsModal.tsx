import React, { useEffect, useState } from 'react';
import type { UserPreferences } from '../services/preferences';
import { DEFAULT_PREFERENCES, isSystemCaptureUsable, resolveSystemAudioSource } from '../services/preferences';
import { switchEngine, CUDA_PROGRESS_URL } from '../api';
import type { CaptureCapabilities, HealthStatus, SystemAudioSource } from '../types';
import type { DesktopSettings } from '../desktop';
import { acceleratorFromKeyboardEvent, formatAccelerator } from '../services/desktop';
import SettingsDropdown from './SettingsDropdown';
import PraxisProjectsPage from './PraxisProjectsPage';

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
}) => {
  const [engineSwitching, setEngineSwitching] = useState(false);
  const [cudaProgress, setCudaProgress] = useState<number>(0);
  const [cudaError, setCudaError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [tab, setTab] = useState<'general' | 'audio' | 'transcription' | 'projects'>('general');

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
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

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
          {(['general', 'audio', 'transcription', 'projects'] as const).map((t) => (
            <button key={t} type="button" className={`settings-tab${tab === t ? ' settings-tab--active' : ''}`} onClick={() => setTab(t)}>
              {t === 'general' ? 'General' : t === 'audio' ? 'Audio' : t === 'transcription' ? 'Transcription' : 'Projects'}
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
        </div>
        <div className="settings-actions">
          <button className="settings-btn settings-btn--danger" onClick={handleReset}>
            {confirmingReset ? 'Are you sure?' : 'Reset to Defaults'}
          </button>
          <button className="settings-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
