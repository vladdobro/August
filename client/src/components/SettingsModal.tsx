import React, { useEffect, useRef, useState } from 'react';
import type { UserPreferences } from '../services/preferences';
import { DEFAULT_PREFERENCES } from '../services/preferences';
import { browsePraxisFolder } from '../api';

interface SettingsModalProps {
  preferences: UserPreferences;
  audioDevices: MediaDeviceInfo[];
  onPreferenceChange: (patch: Partial<UserPreferences>) => void;
  onReset: () => void;
  onClose: () => void;
}

interface SettingsDropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SettingsDropdownProps {
  value: string;
  options: SettingsDropdownOption[];
  onChange: (value: string) => void;
  className?: string;
}

const SettingsDropdown: React.FC<SettingsDropdownProps> = ({ value, options, onChange, className }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div ref={containerRef} className={`settings-dropdown${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="settings-dropdown-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{selectedOption ? selectedOption.label : value}</span>
        <svg className="settings-dropdown-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div className="settings-dropdown-menu">
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              className={`settings-dropdown-item${option.value === value ? ' settings-dropdown-item--active' : ''}${option.disabled ? ' settings-dropdown-item--disabled' : ''}`}
              style={{ animationDelay: `${0.04 + index * 0.04}s` }}
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SettingsModal: React.FC<SettingsModalProps> = ({
  preferences,
  audioDevices,
  onPreferenceChange,
  onReset,
  onClose,
}) => {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [browsing, setBrowsing] = useState(false);

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
  const recordingMode = preferences.recordingMode ?? DEFAULT_PREFERENCES.recordingMode;
  const liveEngine = preferences.liveEngine ?? DEFAULT_PREFERENCES.liveEngine;
  const audioBoost = preferences.audioBoost ?? DEFAULT_PREFERENCES.audioBoost;
  const retranscriptionLanguage = preferences.retranscriptionLanguage ?? DEFAULT_PREFERENCES.retranscriptionLanguage;
  const praxisProjectPath = preferences.praxisProjectPath ?? DEFAULT_PREFERENCES.praxisProjectPath;
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

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await browsePraxisFolder();
      if (result.path) {
        onPreferenceChange({ praxisProjectPath: result.path });
      }
    } catch {
      // dialog cancelled or error
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-card" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>
        <div className="settings-body">
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
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Integration</div>
            <div className="settings-row">
              <label className="settings-label">Praxis Project Path</label>
              <div className="settings-path-group">
                <input
                  type="text"
                  className="settings-control settings-input"
                  value={praxisProjectPath ?? ''}
                  placeholder="Not set"
                  readOnly
                />
                <button
                  type="button"
                  className="settings-btn-inline"
                  onClick={handleBrowse}
                  disabled={browsing}
                >
                  {browsing ? '...' : 'Browse'}
                </button>
                {praxisProjectPath && (
                  <button
                    type="button"
                    className="settings-btn-inline settings-btn-inline--danger"
                    onClick={() => onPreferenceChange({ praxisProjectPath: null })}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          </div>

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
