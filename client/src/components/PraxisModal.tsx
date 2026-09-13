import React, { useState, useEffect, useRef } from 'react';
import { sendToPraxis, validatePraxisProject, browsePraxisFolder } from '../api';

const AugustLogo: React.FC = () => (
  <svg
    className="praxis-success-logo"
    width="42"
    height="42"
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ transform: 'rotate(45deg)' }}
  >
    <circle cx="50" cy="50" r="16" stroke="currentColor" strokeWidth="4" fill="none" />
    <circle cx="50" cy="50" r="12" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.4" />
    <line x1="50" y1="34" x2="50" y2="14" stroke="currentColor" strokeWidth="3.5" />
    <path d="M42 10 Q50 18 58 10" stroke="currentColor" strokeWidth="3.5" fill="none" />
    <circle cx="50" cy="14" r="3" fill="currentColor" />
    <line x1="66" y1="50" x2="90" y2="50" stroke="currentColor" strokeWidth="3.5" />
    <circle cx="90" cy="50" r="3.5" fill="currentColor" />
    <line x1="34" y1="50" x2="10" y2="50" stroke="currentColor" strokeWidth="3.5" />
    <circle cx="10" cy="50" r="3.5" fill="currentColor" />
    <line x1="40" y1="63" x2="18" y2="88" stroke="currentColor" strokeWidth="3.5" />
    <circle cx="18" cy="88" r="3" fill="currentColor" />
    <line x1="60" y1="63" x2="82" y2="88" stroke="currentColor" strokeWidth="3.5" />
    <circle cx="82" cy="88" r="3" fill="currentColor" />
    <line x1="50" y1="66" x2="50" y2="88" stroke="currentColor" strokeWidth="3.5" />
    <circle cx="50" cy="88" r="3" fill="currentColor" />
  </svg>
);

const PraxisLogo: React.FC = () => (
  <svg
    className="praxis-success-logo"
    width="42"
    height="42"
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="50" cy="50" r="8" fill="currentColor" />
    <ellipse cx="50" cy="50" rx="40" ry="16" stroke="currentColor" strokeWidth="4" fill="none" />
    <ellipse cx="50" cy="50" rx="40" ry="16" stroke="currentColor" strokeWidth="4" fill="none" transform="rotate(60 50 50)" />
    <ellipse cx="50" cy="50" rx="40" ry="16" stroke="currentColor" strokeWidth="4" fill="none" transform="rotate(120 50 50)" />
  </svg>
);

const CheckCircleLogo: React.FC = () => (
  <svg
    className="praxis-success-logo"
    width="42"
    height="42"
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="50" cy="50" r="38" stroke="currentColor" strokeWidth="4" fill="none" />
    <polyline points="30,52 45,67 72,35" stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface PraxisModalProps {
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
}

const STORAGE_KEY = 'august-praxis-project-path';

const PraxisModal: React.FC<PraxisModalProps> = ({ sessionId, sessionTitle, onClose }) => {
  const [projectPath, setProjectPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [sending, setSending] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ taskId: string; projectTag: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setProjectPath(saved);
    } catch {
      // localStorage unavailable
    }
    inputRef.current?.focus();
  }, []);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await browsePraxisFolder();
      if (result.path) setProjectPath(result.path);
    } catch {
      // dialog cancelled or error
    } finally {
      setBrowsing(false);
    }
  };

  const handleSend = async () => {
    const trimmed = projectPath.trim();
    if (!trimmed) {
      setError('Please enter a project path');
      return;
    }

    setError(null);
    setValidating(true);

    try {
      const validation = await validatePraxisProject(trimmed);
      if (!validation.valid) {
        setError(`Not a PraxisOS project. No .praxis/ directory found at: ${validation.projectPath}`);
        setValidating(false);
        return;
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to validate project path');
      setValidating(false);
      return;
    }

    setValidating(false);
    setSending(true);

    try {
      const result = await sendToPraxis(sessionId, trimmed);
      try {
        localStorage.setItem(STORAGE_KEY, trimmed);
      } catch {
        // localStorage unavailable
      }
      setSuccess({ taskId: result.taskId, projectTag: result.projectTag });
    } catch (err) {
      setError((err as Error).message || 'Failed to create task');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !sending && !validating && !success) {
      handleSend();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="praxis-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className="praxis-modal" onKeyDown={handleKeyDown}>
        <div className="praxis-modal-header">
          <h3 className="praxis-modal-title">Send to Praxis</h3>
          <button type="button" className="praxis-modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <p className="praxis-modal-subtitle">
          Create a task from <strong>{sessionTitle}</strong>
        </p>

        {!success ? (
          <>
            <label className="praxis-label">
              Project path
              <div className="praxis-input-row">
                <input
                  ref={inputRef}
                  type="text"
                  className="praxis-input"
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  placeholder="D:\path\to\project"
                  disabled={sending || validating}
                />
                <button
                  type="button"
                  className="praxis-btn praxis-btn--browse"
                  onClick={handleBrowse}
                  disabled={sending || validating || browsing}
                >
                  {browsing ? '...' : 'Open'}
                </button>
              </div>
            </label>

            {error && <p className="praxis-error">{error}</p>}

            <div className="praxis-actions">
              <button type="button" className="praxis-btn praxis-btn--cancel" onClick={onClose} disabled={sending || validating}>
                Cancel
              </button>
              <button type="button" className="praxis-btn praxis-btn--send" onClick={handleSend} disabled={sending || validating}>
                {validating ? 'Validating...' : sending ? 'Creating...' : 'Create Task'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="praxis-success">
              <div className="praxis-success-logos">
                <AugustLogo />
                <PraxisLogo />
                <CheckCircleLogo />
              </div>
              <p>Task created successfully</p>
              <span className="praxis-task-id">{success.taskId}</span>
            </div>
            <div className="praxis-actions">
              <button type="button" className="praxis-btn praxis-btn--send" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PraxisModal;
