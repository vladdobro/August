import React from 'react';

type ControlKey = 'upload' | 'settings' | 'archive' | 'keys' | 'diagnostics';

interface ControlsPanelProps {
  active: 'upload' | 'archive' | 'diagnostics' | null;
  onUpload: () => void;
  onSettings: () => void;
  onArchive: () => void;
  onKeys: () => void;
  onDiagnostics: () => void;
}

const ControlsPanel: React.FC<ControlsPanelProps> = ({ active, onUpload, onSettings, onArchive, onKeys, onDiagnostics }) => {
  const items: { key: ControlKey; glyph: string; label: string; desc: string; onClick: () => void }[] = [
    { key: 'upload', glyph: '+', label: 'New session', desc: 'Record, drop a file or paste a link', onClick: onUpload },
    { key: 'settings', glyph: '⚙', label: 'Settings', desc: 'Audio, transcription, projects', onClick: onSettings },
    { key: 'archive', glyph: '▤', label: 'Archive', desc: 'Storage and audio cleanup', onClick: onArchive },
    { key: 'keys', glyph: '⚿', label: 'API Keys', desc: 'Groq and engine tokens', onClick: onKeys },
    { key: 'diagnostics', glyph: '⌁', label: 'Diagnostics', desc: 'Whisper, FFmpeg, GPU status', onClick: onDiagnostics },
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
