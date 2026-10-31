import React, { useEffect, useRef, useState } from 'react';
import type { ActionItem, Participants } from '../types';

interface ActionItemsPanelProps {
  items: ActionItem[];
  participants: Participants;
  variant: 'live' | 'session' | 'compact';
  /// Live only: false -> Online text correction (Groq) is off, show the hint instead of an empty list; null -> not known yet.
  enabled?: boolean | null;
  /// Live only: renders the editable Participants fields.
  onParticipantsChange?: (p: Participants) => void;
  /// AUG-165: when set, the panel offers `+ Add an item` (hand-written item).
  onAdd?: (text: string, owner: string) => void;
  onEdit: (id: string, patch: { text?: string; owner?: string }) => void;
  onDelete: (id: string) => void;
}

/// 'Me' / 'Them' are shown as the participant names entered at recording start.
export function displayOwner(owner: string, p: Participants): string {
  if (owner === 'Me') return p.me || 'Me';
  if (owner === 'Them') return p.them || 'Them';
  return owner;
}

interface InlineFieldProps {
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  multiline?: boolean;
  allowEmpty?: boolean;
  onCommit: (value: string) => void;
}

/// Edits in place: commits on blur and Enter (Shift+Enter keeps a newline in multiline), Escape restores the value.
const InlineField: React.FC<InlineFieldProps> = ({ value, placeholder, ariaLabel, className, multiline, allowEmpty, onCommit }) => {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    const el = areaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [draft]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value.trim() && (allowEmpty || next !== '')) onCommit(next);
    else setDraft(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(value);
      e.currentTarget.blur();
    }
  };

  const common = {
    className,
    value: draft,
    placeholder,
    'aria-label': ariaLabel,
    onFocus: () => { focusedRef.current = true; },
    onBlur: () => { focusedRef.current = false; commit(); },
    onKeyDown: handleKeyDown,
  };

  return multiline ? (
    <textarea
      {...common}
      ref={areaRef}
      rows={1}
      onChange={(e) => {
        setDraft(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
    />
  ) : (
    <input type="text" {...common} onChange={(e) => setDraft(e.target.value)} />
  );
};

interface AddItemFormProps {
  onAdd: (text: string, owner: string) => void;
  onCancel: () => void;
}

/// Add form: Enter (without Shift) or Add submits and closes, Escape or Cancel closes without adding.
const AddItemForm: React.FC<AddItemFormProps> = ({ onAdd, onCancel }) => {
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('');

  const submit = () => {
    const t = text.trim();
    if (t) onAdd(t, owner.trim());
    onCancel();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="action-items-add-form">
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder="What needs to be done"
        aria-label="New action item"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <input type="text" value={owner} placeholder="Owner" aria-label="Owner of the new item" onChange={(e) => setOwner(e.target.value)} onKeyDown={handleKeyDown} />
      <div className="action-items-add-form-actions">
        <button type="button" className="action-items-add-submit" onClick={submit}>Add</button>
        <button type="button" className="action-items-add-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
};

const ActionItemsPanel: React.FC<ActionItemsPanelProps> = ({ items, participants, variant, enabled, onParticipantsChange, onAdd, onEdit, onDelete }) => {
  const [adding, setAdding] = useState(false);
  const compact = variant === 'compact';
  const addForm = onAdd && adding ? <AddItemForm onAdd={onAdd} onCancel={() => setAdding(false)} /> : null;
  const disabledHint = compact
    ? 'Groq off — only manual items'
    : `Turn on Online text correction (Groq) in Settings → Transcription to collect action items during live recording.${onAdd ? ' You can still add items by hand.' : ''}`;
  const emptyText = compact ? 'No items yet' : variant === 'live' ? 'Agreements and tasks will appear here' : 'No action items';

  return (
    <aside className={`action-items-panel action-items-panel--${variant}`} aria-label="Action items">
      {/* Sticky: Add stays reachable however long the list gets. */}
      <div className="action-items-top">
        <div className="action-items-header">
          <span className="action-items-title">Action items</span>
          <span className="action-items-count">{items.length}</span>
          {onAdd && !adding && (
            <button type="button" className={`action-items-add${compact ? ' action-items-add--compact' : ' action-items-add--header'}`} onClick={() => setAdding(true)}>
              {compact ? '[ + ADD ]' : '+ Add an item'}
            </button>
          )}
        </div>
        {addForm}
      </div>
      {!compact && (onParticipantsChange ? (
        <div className="action-items-participants">
          <span className="action-items-participants-label">Participants</span>
          <label className="action-items-participant">
            <span className="action-item-source action-item-source--me">Me</span>
            <InlineField value={participants.me} placeholder="Name (optional)" ariaLabel="Name for Me" allowEmpty onCommit={(v) => onParticipantsChange({ ...participants, me: v })} />
          </label>
          <label className="action-items-participant">
            <span className="action-item-source action-item-source--them">Them</span>
            <InlineField value={participants.them} placeholder="Name (optional)" ariaLabel="Name for Them" allowEmpty onCommit={(v) => onParticipantsChange({ ...participants, them: v })} />
          </label>
        </div>
      ) : (participants.me || participants.them) ? (
        <div className="action-items-participants action-items-participants--readonly">Me = {participants.me || 'Me'} · Them = {participants.them || 'Them'}</div>
      ) : null)}
      {enabled === false && <div className="action-items-hint">{disabledHint}</div>}
      {enabled !== false && items.length === 0 && <div className="action-items-empty">{emptyText}</div>}
      <ul className="action-items-list">
        {/* Newest first: right under the Add form, so a just-added item is always in view. */}
        {[...items].reverse().map((item) => (
          <li key={item.id} className={`action-item${item.locked ? ' action-item--edited' : ''}`} title={item.locked ? 'Edited by you — the model will not change it' : undefined}>
            <InlineField className="action-item-text" multiline value={item.text} ariaLabel="Action item" onCommit={(v) => onEdit(item.id, { text: v })} />
            <div className="action-item-meta">
              {item.manual ? (
                <span className="action-item-source action-item-source--manual" title="Added by you">Manual</span>
              ) : (
                <span className={`action-item-source action-item-source--${item.source.toLowerCase()}`} title="Said by">{item.source}</span>
              )}
              <span className="action-item-arrow" aria-hidden="true">→</span>
              <InlineField className="action-item-owner" value={displayOwner(item.owner, participants)} placeholder="Owner" ariaLabel="Owner" allowEmpty onCommit={(v) => onEdit(item.id, { owner: v })} />
              <button type="button" className="action-item-delete" onClick={() => onDelete(item.id)} aria-label="Delete action item" title="Delete">×</button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
};

export default ActionItemsPanel;
