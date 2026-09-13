import React, { useRef } from 'react';

const AugustLogo: React.FC = () => (
  <svg
    className="about-logo"
    width="64"
    height="64"
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

interface AboutModalProps {
  onClose: () => void;
}

const AboutModal: React.FC<AboutModalProps> = ({ onClose }) => {
  const backdropRef = useRef<HTMLDivElement>(null);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="praxis-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className="praxis-modal about-modal" onKeyDown={handleKeyDown} tabIndex={-1}>
        <div className="praxis-modal-header">
          <h3 className="praxis-modal-title">About August</h3>
          <button type="button" className="praxis-modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="about-content">
          <AugustLogo />

          <div className="about-section">
            <span className="about-label">Created by</span>
            <span className="about-value">Vlad</span>
            <div className="about-links">
              <a className="about-link" href="https://t.me/vladidobr" target="_blank" rel="noopener noreferrer">Telegram</a>
              <a className="about-link" href="https://github.com/vladdobro" target="_blank" rel="noopener noreferrer">GitHub</a>
            </div>
          </div>

          <div className="about-section">
            <span className="about-label">Date</span>
            <span className="about-value">August 2026</span>
          </div>

          <div className="about-section">
            <span className="about-label">Purpose</span>
            <span className="about-value">Audio transcription tool — record or upload meetings, get clean transcripts automatically.</span>
          </div>

          <div className="about-divider" />

          <div className="about-shoutout">
            <span className="about-shoutout-label">Special thanks</span>
            <span className="about-shoutout-name">Reddidgy</span>
            <span className="about-shoutout-role">A beating heart of Praxis that made a dream real</span>
            <div className="about-links">
              <a className="about-link" href="https://t.me/reddidgy" target="_blank" rel="noopener noreferrer">Telegram</a>
              <a className="about-link" href="https://github.com/reddidgy" target="_blank" rel="noopener noreferrer">GitHub</a>
            </div>
          </div>
        </div>

        <div className="praxis-actions">
          <button type="button" className="praxis-btn praxis-btn--send" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default AboutModal;
