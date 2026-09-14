import React, { useEffect, useRef, useState } from 'react';
import { saveGroqKey } from '../api';

const GROQ_CONSOLE_URL = 'https://console.groq.com/keys';

interface GroqKeyModalProps {
  groqAvailable: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const GroqKeyModal: React.FC<GroqKeyModalProps> = ({ groqAvailable, onClose, onSaved }) => {
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleSave = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveGroqKey(trimmed);
      onSaved();
      onClose();
    } catch (err) {
      setSaveError((err as Error).message || 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="groq-setup-backdrop" onClick={onClose}>
      <div className="groq-setup-card" onClick={e => e.stopPropagation()}>
        <div className="groq-setup-header">
          <span className="groq-setup-icon">&#9889;</span>
          <span>{groqAvailable ? 'Update Groq Key' : 'Set up Groq API'}</span>
        </div>
        {!groqAvailable && (
          <ol className="groq-setup-steps">
            <li>
              Open{' '}
              <a href={GROQ_CONSOLE_URL} target="_blank" rel="noopener noreferrer" className="groq-setup-link">
                console.groq.com/keys
              </a>
            </li>
            <li>Create a free account if needed</li>
            <li>Generate an API key and paste it below</li>
          </ol>
        )}
        {groqAvailable && (
          <p className="groq-setup-hint">
            Paste a new key from{' '}
            <a href={GROQ_CONSOLE_URL} target="_blank" rel="noopener noreferrer" className="groq-setup-link">
              console.groq.com/keys
            </a>
          </p>
        )}
        <div className="groq-setup-input-row">
          <input
            ref={inputRef}
            type="password"
            className="groq-setup-input"
            placeholder="gsk_..."
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {saveError && <div className="groq-setup-error">{saveError}</div>}
        {!groqAvailable && <div className="groq-setup-note">Free tier: 20 requests / minute</div>}
        <div className="groq-setup-actions">
          <button type="button" className="groq-setup-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="groq-setup-btn groq-setup-btn--primary"
            onClick={() => void handleSave()}
            disabled={saving || !keyInput.trim()}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroqKeyModal;
