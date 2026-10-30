import React, { useEffect, useState } from 'react';
import type { DesktopUpdateState } from '../desktop';

type ControlKey = 'upload' | 'settings' | 'archive' | 'keys' | 'diagnostics' | 'update';

interface ControlsPanelProps {
  active: 'upload' | 'archive' | 'diagnostics' | null;
  onUpload: () => void;
  onSettings: () => void;
  onArchive: () => void;
  onKeys: () => void;
  onDiagnostics: () => void;
}

const ControlsPanel: React.FC<ControlsPanelProps> = ({ active, onUpload, onSettings, onArchive, onKeys, onDiagnostics }) => {
  // Desktop updater state (AUG-157, moved from the sidebar menu in AUG-160); null hides the item (browser build, unpackaged shell).
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    const api = window.august;
    if (!api?.getUpdateState) return;
    let pushed = false;
    let alive = true;
    const off = api.onUpdateState?.((s) => { pushed = true; setUpdateState(s); });
    api.getUpdateState()
      .then((s) => { if (alive && !pushed) setUpdateState(s); })
      .catch(() => {});
    return () => { alive = false; off?.(); };
  }, []);

  const updateItem = ((): { label: string; desc: string; disabled?: boolean; onClick?: () => void } | null => {
    const u = updateState;
    if (!u) return null;
    switch (u.phase) {
      case 'checking':
        return { label: 'Checking for Updates…', desc: 'Contacting GitHub Releases', disabled: true };
      case 'downloading':
        return { label: `Downloading Update v${u.version} (${u.percent}%)…`, desc: 'Installs on restart', disabled: true };
      case 'ready':
        return { label: `Restart to Update to v${u.version}`, desc: 'Restart August to install', onClick: () => window.august?.installUpdate?.() };
      default:
        return { label: 'Check for Updates', desc: 'Look for a new August version', onClick: () => window.august?.checkForUpdates?.() };
    }
  })();

  const items: { key: ControlKey; glyph: string; label: string; desc: string; disabled?: boolean; onClick?: () => void }[] = [
    { key: 'upload', glyph: '+', label: 'New session', desc: 'Record, drop a file or paste a link', onClick: onUpload },
    { key: 'settings', glyph: '⚙', label: 'Settings', desc: 'Audio, transcription, projects', onClick: onSettings },
    { key: 'archive', glyph: '▤', label: 'Archive', desc: 'Storage and audio cleanup', onClick: onArchive },
    { key: 'keys', glyph: '⚿', label: 'API Keys', desc: 'Groq and engine tokens', onClick: onKeys },
    { key: 'diagnostics', glyph: '⌁', label: 'Diagnostics', desc: 'Whisper, FFmpeg, GPU status', onClick: onDiagnostics },
    ...(updateItem ? [{ key: 'update' as const, glyph: '↻', ...updateItem }] : []),
  ];

  return (
    <div className="controls-list">
      {items.map(item => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            className={`controls-item${isActive ? ' controls-item--active' : ''}`}
            onClick={item.onClick}
            disabled={item.disabled}
          >
            <span className="controls-icon" aria-hidden="true">{item.glyph}</span>
            <span className="controls-text">
              <span className="controls-label">{item.label}</span>
              <span className="controls-desc">{item.desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default ControlsPanel;
