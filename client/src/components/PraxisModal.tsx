import React, { useState, useEffect, useRef } from 'react';
import { sendToPraxis, validatePraxisProject } from '../api';

interface PraxisModalProps {
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
}

const STORAGE_KEY = 'august-praxis-project-path';

const PraxisModal: React.FC<PraxisModalProps> = ({ sessionId, sessionTitle, onClose }) => {
  const [projectPath, setProjectPath] = useState('');
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
              <input
                ref={inputRef}
                type="text"
                className="praxis-input"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="D:\path\to\project"
                disabled={sending || validating}
              />
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
              <svg className="praxis-success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
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
