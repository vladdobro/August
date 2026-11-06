import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/// AUG-197: the "Turn on Always-on Claude?" confirmation, shared by Settings → AI assistants and the COPILOT column.
const formatUsd = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

interface Props {
  budgetUsd: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

const AlwaysOnConfirmModal: React.FC<Props> = ({ budgetUsd, busy, error, onCancel, onConfirm }) => {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return createPortal(
    <div className="groq-setup-backdrop" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="settings-confirm-card" role="dialog" aria-modal="true" aria-labelledby="ai-always-title" onClick={(e) => e.stopPropagation()}>
        <div className="settings-confirm-title" id="ai-always-title">Turn on Always-on Claude?</div>
        <p className="settings-confirm-text">
          Always-on Claude sends the whole conversation to Anthropic as it happens, through your Claude account. A one-hour meeting costs about $1–2.50 of your Claude usage;{' '}
          {budgetUsd === 0 ? 'you chose no spending limit.' : `it stops at your limit of $${formatUsd(budgetUsd)}.`}
        </p>
        <label className="settings-confirm-check">
          <input type="checkbox" autoFocus checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I understand the whole conversation leaves this computer</span>
        </label>
        {error && <div className="groq-setup-error">{error}</div>}
        <div className="groq-setup-actions">
          <button type="button" className="groq-setup-btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="groq-setup-btn groq-setup-btn--primary settings-confirm-btn--danger"
            disabled={!checked || busy}
            onClick={onConfirm}
          >
            Turn on
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AlwaysOnConfirmModal;
