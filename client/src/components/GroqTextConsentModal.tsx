import React, { useEffect } from 'react';

interface GroqTextConsentModalProps {
  groqAvailable: boolean;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onAddKey: () => void;
  onCancel: () => void;
}

const GroqTextConsentModal: React.FC<GroqTextConsentModalProps> = ({ groqAvailable, busy, error, onAccept, onAddKey, onCancel }) => {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onCancel]);

  return (
    <div className="groq-setup-backdrop" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="groq-setup-card" onClick={(e) => e.stopPropagation()}>
        <div className="groq-setup-header">
          <span className="groq-setup-icon">&#9889;</span>
          <span>Online text correction (Groq)</span>
        </div>
        <ol className="groq-setup-steps">
          <li>A) Transcript text — and, during live recordings, the participant names you enter and the collected action items — is sent to Groq and may be used by Groq under its own terms.</li>
          <li>B) It needs your own Groq API key (GROQ_API_KEY).{!groqAvailable && ' No key is set yet.'}</li>
        </ol>
        <p className="groq-setup-hint">
          Only Groq&apos;s free tier is used. When the free limit runs out, checks are skipped silently. Live lines are fixed in place. During live recordings it also collects action items (tasks and agreements) next to the transcript; they are saved with the session. After a recording, doubtful lines are sent too and come back as suggestions you accept or reject; the original transcript is never changed.
        </p>
        {error && <div className="groq-setup-error">{error}</div>}
        <div className="groq-setup-actions">
          <button type="button" className="groq-setup-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="groq-setup-btn groq-setup-btn--primary"
            onClick={groqAvailable ? onAccept : onAddKey}
            disabled={busy}
          >
            {groqAvailable ? 'Agree and enable' : 'Add Groq key'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroqTextConsentModal;
