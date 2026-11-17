import React, { useEffect, useRef, useState } from 'react';
import type { ActionItem, Participants } from '../types';
import { formatClock, scrollBehavior } from '../services/actionItemSource';

/// AUG-214: how an item reaches its source line.
export interface ActionItemSourceNav {
  /// 'jump' = the source line is known; 'find' = no stored line, search by word overlap; 'none' = no jump controls.
  target: (item: ActionItem) => 'jump' | 'find' | 'none';
  /// Non-null disables the jump controls and explains why; `warn` shows the text in the yellow-outlined box.
  blocked: (item: ActionItem) => { text: string; warn?: boolean } | null;
  go: (item: ActionItem) => void;
  /// Returns false when no line matches.
  find?: (item: ActionItem) => boolean;
  /// AUG-215 (saved session only): play the session audio from the item's moment. Absent / false = no Play control at all.
  canPlay?: (item: ActionItem) => boolean;
  play?: (item: ActionItem) => void;
  /// Card whose source line is highlighted now (accent outline).
  ownerId: string | null;
  /// Changes when the user comes back from the highlighted line: scroll to the card and expand it.
  reveal: { id: string; n: number } | null;
}

interface ActionItemsPanelProps {
  items: ActionItem[];
  participants: Participants;
  variant: 'live' | 'session' | 'compact';
  /// Live only: false -> Online text (Groq) or Collect live action items is off, show the hint instead of an empty list; null -> not known yet.
  enabled?: boolean | null;
  /// AUG-190: why live items are off; 'items' = Groq on but Collect live action items off.
  offReason?: 'groq' | 'items' | 'manual' | null; // AUG-200: 'manual' = meeting-only socket (Live Text off)
  /// Live only: renders the editable Participants fields.
  onParticipantsChange?: (p: Participants) => void;
  /// AUG-165: when set, the panel offers `+ Add an item` (hand-written item).
  onAdd?: (text: string, owner: string) => void;
  onEdit: (id: string, patch: { text?: string; owner?: string; context?: string }) => void;
  onDelete: (id: string) => void;
  /// AUG-166: when set (live + session variants), items get checkboxes and the Praxis export bar.
  onSendToPraxis?: (ids: string[], mode: 'separate' | 'common') => void;
  /// AUG-199: inside a LiveColumn, whose header already shows the title and count.
  embedded?: boolean;
  // AUG-204: compact "Turn on automatic items" link
  onEnableAuto?: () => void;
  /// AUG-214: source jump, supplied by the owner of the transcript (live panel / TranscriptView). Ignored by the compact variant.
  source?: ActionItemSourceNav;
}

/// AUG-166: `AUG-12-ab12cd` -> `AUG-12`.
export function shortTaskId(id: string): string {
  const m = id.match(/^(.*\d)-[a-z0-9]+$/i);
  return m ? m[1] : id;
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

  // AUG-212: scrollHeight is 0 while an ancestor is display:none (html.compact-dock hides #root, FileUpload stays mounted);
  // pinning 0px then hid the item text after expanding back to the full window. Keep 'auto' in that case.
  const fitArea = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    if (h > 0) el.style.height = `${h}px`;
  };

  useEffect(fitArea, [draft]);

  // AUG-212: re-fit when the textarea becomes visible again or its column width changes (text rewraps).
  useEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = -1;
    let frame = 0;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w === lastWidth) return;
      lastWidth = w;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitArea);
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [multiline]);

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
      onChange={(e) => setDraft(e.target.value)}
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

interface ItemContextBlockProps {
  item: ActionItem;
  participants: Participants;
  clock: string | null;
  source?: ActionItemSourceNav;
  target: 'jump' | 'find' | 'none';
  blocked: { text: string; warn?: boolean } | null;
  onEdit: (id: string, patch: { context?: string }) => void;
}

/// AUG-214: expanded block of a card: summary (editable), who said it and when, the verbatim quote, the jump.
const ItemContextBlock: React.FC<ItemContextBlockProps> = ({ item, participants, clock, source, target, blocked, onEdit }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [findMiss, setFindMiss] = useState(false);
  const cancelledRef = useRef(false);
  const refocusRef = useRef(false);
  const editBtnRef = useRef<HTMLButtonElement>(null);

  // Enter / Escape hand the focus back to Edit; a click elsewhere keeps the focus where the user put it.
  useEffect(() => {
    if (!editing && refocusRef.current) {
      refocusRef.current = false;
      editBtnRef.current?.focus();
    }
  }, [editing]);

  const anchor = item.anchor;
  const quote = anchor?.quote ?? '';
  const warnBox = blocked?.warn ? <div className="action-item-context-warn" role="status">{blocked.text}</div> : null;
  const findControls = target === 'find' && source?.find ? (
    <>
      <button type="button" className="action-item-chip" disabled={!!blocked} title={blocked?.text} onClick={() => setFindMiss(!source.find!(item))}>Find in transcript</button>
      {findMiss && <span className="action-item-context-muted" role="status">No matching line found.</span>}
    </>
  ) : null;

  // Recorded before AUG-213: nothing was stored about where the item came from.
  if (!anchor && !item.manual) {
    return (
      <div className="action-item-context">
        <div className="action-item-context-muted">No source was saved for this item (recorded before this feature).</div>
        {warnBox}
        {findControls && <div className="action-item-context-acts">{findControls}</div>}
      </div>
    );
  }

  const startEdit = () => { cancelledRef.current = false; setDraft(item.context ?? ''); setEditing(true); };
  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== (item.context ?? '')) onEdit(item.id, { context: next });
  };
  const showWhy = !(item.manual && !item.context && !item.locked?.context);
  const speaker = anchor?.speaker ?? item.source;
  const canPlay = !!source?.play && !!source.canPlay?.(item);

  return (
    <div className="action-item-context">
      {showWhy && (
        <>
          <div className="action-item-context-label">
            Why / what
            {!editing && <button ref={editBtnRef} type="button" className="action-item-chip" onClick={startEdit}>Edit</button>}
          </div>
          {editing ? (
            <textarea
              autoFocus
              value={draft}
              maxLength={240}
              aria-label="Summary"
              onFocus={(e) => { const end = e.currentTarget.value.length; e.currentTarget.setSelectionRange(end, end); }}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { if (cancelledRef.current) { cancelledRef.current = false; return; } save(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  refocusRef.current = true;
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelledRef.current = true;
                  refocusRef.current = true;
                  setEditing(false);
                }
              }}
            />
          ) : item.context ? (
            <div>{item.context}</div>
          ) : (
            <div className="action-item-context-muted">{quote ? 'No summary for this item — the quote below is the source.' : 'No summary for this item.'}</div>
          )}
        </>
      )}
      {item.manual ? (
        <div>{clock ? `Added by hand at ${clock}. ` : 'Added by hand. '}No quote — the item was not taken from speech.</div>
      ) : anchor?.kind === 'added' ? (
        <div>{clock ? `Added at ${clock}. ` : ''}No quote — the item was not taken from speech.</div>
      ) : (
        <>
          <div className="action-item-context-label">Said by {displayOwner(speaker, participants)}{clock ? ` · ${clock}` : ''}</div>
          {quote
            ? <blockquote className={`action-item-quote${speaker === 'Them' ? ' action-item-quote--them' : ''}`}>«{quote}»</blockquote>
            : <div className="action-item-context-muted">The exact words were not saved for this item.</div>}
        </>
      )}
      {warnBox}
      {(target !== 'none' || canPlay || (blocked && !blocked.warn)) && (
        <div className="action-item-context-acts">
          {target === 'jump' && source && (
            <button type="button" className="action-item-chip" disabled={!!blocked} title={blocked?.text} onClick={() => source.go(item)}>Show in transcript</button>
          )}
          {findControls}
          {canPlay && <button type="button" className="action-item-chip" onClick={() => source!.play!(item)}>▶ Play from here</button>}
          {blocked && !blocked.warn && target !== 'none' && <span className="action-item-context-muted">{blocked.text}</span>}
        </div>
      )}
    </div>
  );
};

const ActionItemsPanel: React.FC<ActionItemsPanelProps> = ({ items, participants, variant, enabled, offReason, onParticipantsChange, onAdd, onEdit, onDelete, onSendToPraxis, embedded, onEnableAuto, source }) => {
  const [adding, setAdding] = useState(false);
  const compact = variant === 'compact';
  const exportEnabled = Boolean(onSendToPraxis) && !compact;
  const compactPraxis = compact && Boolean(onSendToPraxis); // AUG-188
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedIds = items.filter((i) => selected.has(i.id)).map((i) => i.id);
  const allSelected = items.length > 0 && selectedIds.length === items.length;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedIds.length > 0 && !allSelected;
  }, [selectedIds.length, allSelected]);
  const toggleOne = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // AUG-214: context blocks (never in the compact variant)
  const rich = !compact;
  const nav = rich ? source : undefined;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const listRef = useRef<HTMLUListElement>(null);
  const revealId = nav?.reveal?.id;
  const revealN = nav?.reveal?.n;
  useEffect(() => {
    if (!revealId) return;
    setExpanded((prev) => (prev.has(revealId) ? prev : new Set(prev).add(revealId)));
    const frame = requestAnimationFrame(() => {
      const el = Array.from(listRef.current?.children ?? []).find((c) => (c as HTMLElement).dataset.itemId === revealId) as HTMLElement | undefined;
      const list = listRef.current;
      if (el && list) {
        // Scroll the list itself: scrollIntoView on the card would also move overflow-hidden ancestors of the live panel.
        const r = el.getBoundingClientRect();
        const c = list.getBoundingClientRect();
        list.scrollTo({ top: list.scrollTop + (r.top - c.top) - list.clientHeight / 2 + r.height / 2, behavior: scrollBehavior() });
        list.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }); // session card: bring the list back into the page view
      }
      el?.querySelector<HTMLElement>('.action-item-ctx-toggle')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [revealId, revealN]);
  const addForm =onAdd && adding ? <AddItemForm onAdd={onAdd} onCancel={() => setAdding(false)} /> : null;
  const itemsOff = offReason === 'items';
  const disabledHint = offReason === 'manual'
    ? `Live text is off, so action items are not collected automatically.${onAdd ? ' Add them by hand or with → Action item in ASSISTANT.' : ''}`
    : itemsOff
      ? `Turn on Collect live action items in Settings → Transcription to collect action items during live recording.${onAdd ? ' You can still add items by hand.' : ''}`
      : `Turn on Online text (Groq) in Settings → Transcription to collect action items during live recording.${onAdd ? ' You can still add items by hand.' : ''}`;
  const emptyText = compact ? 'No items yet' : variant === 'live' ? 'Agreements and tasks will appear here' : 'No action items';

  return (
    <aside className={`action-items-panel action-items-panel--${variant}`} aria-label="Action items">
      {/* Sticky: Add stays reachable however long the list gets. */}
      <div className="action-items-top">
        <div className="action-items-header">
          {!embedded && <span className="action-items-title">Action items</span>}
          {!embedded && <span className="action-items-count">{items.length}</span>}
          {onAdd && !adding && (
            <button type="button" className={`action-items-add${compact ? ' action-items-add--compact' : ' action-items-add--header'}`} onClick={() => setAdding(true)}>
              {compact ? '[ + ADD ]' : '+ Add an item'}
            </button>
          )}
          {compactPraxis && items.length > 0 && (
            <button type="button" className="action-items-add action-items-add--compact action-items-praxis-all" onClick={() => onSendToPraxis?.(items.map((i) => i.id), 'separate')} title="Send all items to Praxis">[ → PRAXIS ]</button>
          )}
        </div>
        {addForm}
        {exportEnabled && items.length > 0 && (
          <div className="action-items-export">
            <label className="action-items-select-all">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
              />
              Select all
            </label>
            <span className="action-items-selected-count">{selectedIds.length} selected</span>
            <button type="button" className="action-items-praxis-btn action-items-praxis-btn--primary" disabled={selectedIds.length === 0} onClick={() => onSendToPraxis?.(selectedIds, 'separate')}>Separate tasks</button>
            <button type="button" className="action-items-praxis-btn" disabled={selectedIds.length === 0} onClick={() => onSendToPraxis?.(selectedIds, 'common')}>One task</button>
          </div>
        )}
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
      {enabled === false && (compact ? (
        <div className="action-items-hint action-items-hint--plain">
          <span>{offReason === 'manual' ? 'Action items: add by hand (live text is off)' : 'Action items: add by hand'}</span>
          {offReason !== 'manual' && onEnableAuto && (
            <button type="button" className="action-items-hint-link" onClick={onEnableAuto}>Turn on automatic items</button>
          )}
        </div>
      ) : <div className="action-items-hint">{disabledHint}</div>)}
      {enabled !== false && items.length === 0 && <div className="action-items-empty">{emptyText}</div>}
      <ul className="action-items-list" ref={listRef}>
        {/* Newest first: right under the Add form, so a just-added item is always in view. */}
        {[...items].reverse().map((item) => {
          const atMs = item.anchor?.atMs;
          const clock = typeof atMs === 'number' ? formatClock(atMs) : null;
          const quote = item.anchor?.quote ?? '';
          const open = rich && expanded.has(item.id);
          const target = nav ? nav.target(item) : 'none';
          const blocked = nav && target !== 'none' ? nav.blocked(item) : null;
          // AUG-214: summary -> start of the quote -> "Added by hand at" -> no row at all
          const summaryRow = item.context ? item.context : quote ? `«${quote}»` : item.manual && clock ? `Added by hand at ${clock}` : '';
          const owned = rich && nav?.ownerId === item.id;
          const rightControls = (
            <>
              {rich && (
                <button type="button" className="action-item-chip action-item-ctx-toggle" aria-expanded={open} onClick={() => toggleExpanded(item.id)}>Context {open ? '▴' : '▾'}</button>
              )}
              {exportEnabled && onSendToPraxis && (
                <button type="button" className="action-item-praxis" onClick={() => onSendToPraxis([item.id], 'separate')} title="Create a Praxis task from this item">→ Praxis</button>
              )}
              {compactPraxis && (
                <button type="button" className="action-item-praxis action-item-praxis--compact" onClick={() => onSendToPraxis?.([item.id], 'separate')} title="Send to Praxis" aria-label="Send to Praxis">→</button>
              )}
              <button type="button" className="action-item-delete" onClick={() => onDelete(item.id)} aria-label="Delete action item" title="Delete">×</button>
            </>
          );
          return (
            <li key={item.id} data-item-id={item.id} className={`action-item${item.locked ? ' action-item--edited' : ''}${exportEnabled ? ' action-item--selectable' : ''}${owned ? ' action-item--owned' : ''}`} title={item.locked ? 'Edited by you — the model will not change it' : undefined}>
              {exportEnabled && (
                <input type="checkbox" className="action-item-check" aria-label="Select action item" checked={selected.has(item.id)} onChange={() => toggleOne(item.id)} />
              )}
              <div className="action-item-body">
              <InlineField className="action-item-text" multiline value={item.text} ariaLabel="Action item" onCommit={(v) => onEdit(item.id, { text: v })} />
              {rich && summaryRow && <div className="action-item-summary">{summaryRow}</div>}
              {rich && item.locked?.context && <div className="action-item-edited-note">Edited by you</div>}
              <div className="action-item-meta">
                {item.manual ? (
                  <span className="action-item-source action-item-source--manual" title="Added by you">Manual</span>
                ) : (
                  <span className={`action-item-source action-item-source--${item.source.toLowerCase()}`} title="Said by">{item.source}</span>
                )}
                <span className="action-item-arrow" aria-hidden="true">→</span>
                <InlineField className="action-item-owner" value={displayOwner(item.owner, participants)} placeholder="Owner" ariaLabel="Owner" allowEmpty onCommit={(v) => onEdit(item.id, { owner: v })} />
                {item.assistant && <span className="live-ai-tag" title="Added by the meeting assistant">AI</span>}
                {item.praxis && (
                  <span className="action-item-praxis-badge" title={`Sent to Praxis: ${item.praxis.projectPath}`}>{shortTaskId(item.praxis.taskId)}</span>
                )}
                {nav && clock && target === 'jump' && (
                  <button type="button" className="action-item-chip" disabled={!!blocked} title={blocked ? blocked.text : 'Show in transcript'} aria-label={`Show in transcript, ${clock}`} onClick={() => nav.go(item)}>{clock} ↗</button>
                )}
                {rich ? <span className="action-item-meta-right">{rightControls}</span> : rightControls}
              </div>
              {open && <ItemContextBlock item={item} participants={participants} clock={clock} source={nav} target={target} blocked={blocked} onEdit={onEdit} />}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};

export default ActionItemsPanel;
