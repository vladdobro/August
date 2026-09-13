import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionMetadata, SessionStatus } from '../types';
import AboutModal from './AboutModal';

interface SessionListProps {
  sessions: SessionMetadata[];
  selectedSessionId: string | null;
  pendingDeleteId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onUndoDelete: () => void;
  onRename: (id: string, title: string) => void;
  onNewSession: () => void;
  onDiagnostics: () => void;
}

const ALL_STATUSES: SessionStatus[] = ['uploading', 'transcribing', 'failed', 'completed'];

const CHIP_LAYOUT = [
  { cx: 16, cy: 28, size: 48 },
  { cx: 40, cy: 72, size: 42 },
  { cx: 60, cy: 28, size: 46 },
  { cx: 84, cy: 72, size: 40 },
];

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'uploading':
      return 'Uploading';
    case 'transcribing':
      return 'Transcribing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

function chipLabel(status: SessionStatus): string {
  switch (status) {
    case 'uploading': return 'UPL';
    case 'transcribing': return 'TRC';
    case 'completed': return 'DONE';
    case 'failed': return 'ERR';
    default: return status.slice(0, 3).toUpperCase();
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const SessionList: React.FC<SessionListProps> = ({
  sessions,
  selectedSessionId,
  pendingDeleteId,
  onSelect,
  onDelete,
  onUndoDelete,
  onRename,
  onNewSession,
  onDiagnostics,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<SessionStatus>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const [rayLines, setRayLines] = useState<{ x1: number; y1: number; x2: number; y2: number }[]>([]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  useLayoutEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) return;
      const gap = 2;
      const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
      for (let i = 0; i < CHIP_LAYOUT.length - 1; i++) {
        const a = CHIP_LAYOUT[i];
        const b = CHIP_LAYOUT[i + 1];
        const rAx = (a.size / 2 + gap) * 100 / w;
        const rAy = (a.size / 2 + gap) * 100 / h;
        const rBx = (b.size / 2 + gap) * 100 / w;
        const rBy = (b.size / 2 + gap) * 100 / h;
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const len = Math.sqrt(dx * dx + dy * dy);
        const ux = dx / len;
        const uy = dy / len;
        const tA = 1 / Math.sqrt((ux * ux) / (rAx * rAx) + (uy * uy) / (rAy * rAy));
        const tB = 1 / Math.sqrt((ux * ux) / (rBx * rBx) + (uy * uy) / (rBy * rBy));
        lines.push({
          x1: a.cx + tA * ux,
          y1: a.cy + tA * uy,
          x2: b.cx - tB * ux,
          y2: b.cy - tB * uy,
        });
      }
      setRayLines(lines);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggleFilter = (status: SessionStatus) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  const filteredSessions = sessions.filter((session) => {
    if (searchQuery && !session.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (activeFilters.size > 0 && !activeFilters.has(session.status)) {
      return false;
    }
    return true;
  });

  const startRename = (session: SessionMetadata) => {
    setEditingId(session.id);
    setEditValue(session.title);
  };

  const commitRename = () => {
    if (editingId && editValue.trim() && editValue.trim() !== sessions.find(s => s.id === editingId)?.title) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, session: SessionMetadata) => {
    if (editingId === session.id) return;

    switch (e.key) {
      case 'Enter':
        onSelect(session.id);
        break;
      case 'Delete': {
        e.preventDefault();
        onDelete(session.id);
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        const items = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
        if (items) {
          const idx = Array.from(items).indexOf(e.currentTarget as HTMLElement);
          if (idx < items.length - 1) items[idx + 1].focus();
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const items = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
        if (items) {
          const idx = Array.from(items).indexOf(e.currentTarget as HTMLElement);
          if (idx > 0) items[idx - 1].focus();
        }
        break;
      }
    }
  };

  const hasFilters = searchQuery || activeFilters.size > 0;

  return (
    <div className="session-list">
      <svg className="session-list-hex-bg" viewBox="0 0 300 800" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <pattern id="sidebar-hex-grid" width="28" height="48.5" patternUnits="userSpaceOnUse" patternTransform="scale(1.2)">
            <path d="M14 0L28 8.1V24.2L14 32.3L0 24.2V8.1Z" fill="none" stroke="currentColor" strokeWidth="0.5"/>
            <path d="M14 16.2L28 24.3V40.4L14 48.5L0 40.4V24.3Z" fill="none" stroke="currentColor" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#sidebar-hex-grid)"/>
      </svg>
      <div className="session-list-header">
        <div className="session-header-left">
          <h1 className="app-title app-title--clickable" onClick={() => setShowAbout(true)}>August</h1>
          <div className="sidebar-menu" ref={menuRef}>
            <button
              type="button"
              className="sidebar-menu-trigger"
              onClick={() => setMenuOpen(v => !v)}
              aria-label="Menu"
              aria-expanded={menuOpen}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            </button>
            {menuOpen && (
              <div className="sidebar-menu-dropdown">
                <button
                  type="button"
                  className="sidebar-menu-item sidebar-menu-item--1"
                  onClick={() => { setMenuOpen(false); onDiagnostics(); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
                  </svg>
                  Diagnostics
                </button>
                <a
                  className="sidebar-menu-item sidebar-menu-item--2"
                  href="https://youtu.be/dQw4w9WgXcQ"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMenuOpen(false)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  tooltip_missing
                </a>
              </div>
            )}
          </div>
        </div>
        <button type="button" className="new-session-node" onClick={onNewSession} aria-label="New session">
          +
        </button>
      </div>

      <div className="session-list-filters">
        <input
          type="text"
          className="session-search-input"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="session-filter-chips" ref={chipsRef}>
          <svg className="chip-rays-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {rayLines.map((l, i) => (
              <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="chip-ray-line" />
            ))}
          </svg>
          {ALL_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`session-filter-chip session-filter-chip--${status}${activeFilters.has(status) ? ' active' : ''}`}
              onClick={() => toggleFilter(status)}
              aria-pressed={activeFilters.has(status)}
              title={statusLabel(status)}
            >
              {chipLabel(status)}
            </button>
          ))}
        </div>
      </div>

      <div className="session-hex-divider" aria-hidden="true">
        <span className="session-hex-dot" />
        <span className="session-hex-dot" />
        <span className="session-hex-dot" />
        <span className="session-hex-dot" />
        <span className="session-hex-dot" />
      </div>

      <div className="session-list-items" role="listbox" aria-label="Sessions" ref={listRef}>
        {sessions.length === 0 && (
          <div className="session-list-empty">
            <svg className="empty-illustration" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="40" cy="40" r="38" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
              <rect x="34" y="18" width="12" height="28" rx="6" stroke="currentColor" strokeWidth="2" opacity="0.6" />
              <path d="M28 38c0 6.627 5.373 12 12 12s12-5.373 12-12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
              <line x1="40" y1="50" x2="40" y2="58" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
              <line x1="34" y1="58" x2="46" y2="58" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
              <rect x="58" y="30" width="2.5" height="14" rx="1.25" fill="currentColor" opacity="0.18" />
              <rect x="63" y="26" width="2.5" height="22" rx="1.25" fill="currentColor" opacity="0.12" />
              <rect x="68" y="32" width="2.5" height="10" rx="1.25" fill="currentColor" opacity="0.18" />
              <rect x="14" y="32" width="2.5" height="10" rx="1.25" fill="currentColor" opacity="0.18" />
              <rect x="19" y="28" width="2.5" height="18" rx="1.25" fill="currentColor" opacity="0.12" />
              <rect x="9" y="34" width="2.5" height="6" rx="1.25" fill="currentColor" opacity="0.12" />
            </svg>
            <p className="empty-headline">Record or upload your first meeting</p>
            <ol className="empty-steps">
              <li>Upload audio or record live</li>
              <li>August transcribes automatically</li>
              <li>Review and copy the result</li>
            </ol>
            <div className="empty-arrow" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12h14m0 0l-5-5m5 5l-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
        )}

        {sessions.length > 0 && filteredSessions.length === 0 && hasFilters && (
          <div className="session-list-empty">No sessions match your search</div>
        )}

        {filteredSessions.map((session) =>
          session.id === pendingDeleteId ? (
            <div key={session.id} className="session-item session-item-undo" role="status" aria-live="polite">
              <span className="session-undo-text">Deleted</span>
              <button type="button" className="session-undo-action" onClick={onUndoDelete}>
                Undo
              </button>
              <div className="session-undo-progress" />
            </div>
          ) : (
          <div
            key={session.id}
            className={`session-item ${session.id === selectedSessionId ? 'active' : ''}`}
            role="option"
            tabIndex={0}
            aria-selected={session.id === selectedSessionId}
            aria-label={`${session.title}, ${statusLabel(session.status)}`}
            onClick={() => onSelect(session.id)}
            onKeyDown={(e) => handleItemKeyDown(e, session)}
          >
            <div className="session-bracket-row">
              <div className="session-bracket session-bracket--l"><span className="session-bracket-bb" /></div>
              <div className="session-bline">
                {editingId !== session.id && (
                  <button
                    type="button"
                    className="session-edit-button"
                    title="Rename session"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(session);
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      <path d="m15 5 4 4" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="session-bnode">
                <span className="session-bnode-dot" />
                {session.id === selectedSessionId && (
                  <>
                    <span className="session-bracket-pulse" />
                    <span className="session-bracket-pulse" style={{ animationDelay: '0.8s' }} />
                  </>
                )}
              </div>
              <div className="session-bline">
                <button
                  type="button"
                  className="session-delete-button"
                  title="Delete session"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="session-bracket session-bracket--r"><span className="session-bracket-bb" /></div>
            </div>
            <div className="session-item-main">
              {editingId === session.id ? (
                <input
                  ref={inputRef}
                  className="session-rename-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitRename();
                    } else if (e.key === 'Escape') {
                      cancelRename();
                    }
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div
                  className="session-item-title"
                  title={session.title}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(session);
                  }}
                >
                  {session.title}
                </div>
              )}
              <div className="session-item-meta">
                <span className={`status-badge status-${session.status}`}>
                  {(session.status === 'transcribing' || session.status === 'uploading') && (
                    <span className="status-spinner" />
                  )}
                  {statusLabel(session.status)}
                </span>
                <span className="session-item-date">{formatDate(session.createdAt)}</span>
              </div>
            </div>
          </div>
          )
        )}
      </div>
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  );
};

export default SessionList;
