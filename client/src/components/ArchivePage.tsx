import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteSession, deleteSessionAudio, fetchStorage, redownloadSessionAudio } from '../api';
import type { SessionSource, SessionStatus, SessionStorageEntry, SessionStorageFile, StorageSummary } from '../types';

interface ArchivePageProps {
  onBack: () => void;
  onChanged: (deletedIds: string[]) => void | Promise<void>;
  isRecording: boolean;
  onReturnToRecording: () => void;
}

const POLL_INTERVAL_MS = 5000;
const ACTIVE_STATUSES: SessionStatus[] = ['uploading', 'preparing', 'transcribing'];

type DialogState =
  | { mode: 'sessions'; ids: string[] }
  | { mode: 'audio'; ids: string[] }
  | { mode: 'file'; ids: [string]; file: SessionStorageFile };

function isActiveEntry(e: SessionStorageEntry): boolean {
  return ACTIVE_STATUSES.includes(e.status);
}

function formatBytes(n: number): string {
  if (n < 1024) return '0 KB';
  const kb = n / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function sourceLabel(entry: SessionStorageEntry): { text: string; className: string } {
  const source: SessionSource = entry.source;
  switch (source) {
    case 'recording':
      return { text: 'MIC', className: 'archive-src archive-src--recording' };
    case 'upload':
      return { text: 'FILE', className: 'archive-src archive-src--upload' };
    case 'link':
      return { text: 'LINK', className: 'archive-src archive-src--link' };
    case 'platform': {
      let host = '';
      try {
        host = new URL(entry.sourceUrl ?? '').hostname;
      } catch {
        // keep empty host
      }
      return { text: host.includes('youtu') ? 'YT' : 'VIDEO', className: 'archive-src archive-src--platform' };
    }
  }
}

function fileNote(file: SessionStorageFile): string {
  if (file.deleted) return '';
  if (file.note === 'original') return '(original)';
  if (file.note === 'converted') return '(converted for whisper)';
  if (file.note === 'boosted') return '(boosted)';
  return '';
}

/// Estimated size of a re-download: the deleted source files, falling back to everything deleted.
function estimateRedownloadBytes(entry: SessionStorageEntry): number {
  const deleted = entry.files.filter((f) => f.deleted);
  const originals = deleted.filter((f) => f.note === 'original' || (!f.note && !f.name.toLowerCase().endsWith('.wav')));
  const pool = originals.length > 0 ? originals : deleted;
  return pool.reduce((sum, f) => sum + f.bytes, 0);
}

const ArchivePage: React.FC<ArchivePageProps> = ({ onBack, onChanged, isRecording, onReturnToRecording }) => {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [running, setRunning] = useState(false);
  const [redownloadOpenId, setRedownloadOpenId] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<StorageSummary | null> => {
    try {
      const next = await fetchStorage();
      if (!mountedRef.current) return next;
      setSummary(next);
      setError(null);
      return next;
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message || 'Failed to load storage');
      return null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  const sessions = summary?.sessions ?? [];
  const selectable = useMemo(() => sessions.filter((s) => !isActiveEntry(s)), [sessions]);

  // Selection drops ids that became active or disappeared after a refresh.
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(selectable.map((s) => s.id));
      const next = new Set([...prev].filter((id) => allowed.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectable]);

  const allSelected = selectable.length > 0 && selectable.every((s) => selected.has(s.id));
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selected.size > 0 && !allSelected;
  }, [selected, allSelected]);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) setDialog(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog, running]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const selectedEntries = sessions.filter((s) => selected.has(s.id));
  const selectedBytes = selectedEntries.reduce((sum, s) => sum + s.totalBytes, 0);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelected = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (on: boolean) => {
    setSelected(on ? new Set(selectable.map((s) => s.id)) : new Set());
  };

  const openReveal = async () => {
    try {
      const result = await window.august?.revealSessionsDir?.();
      if (result && !result.ok) console.error('revealSessionsDir failed:', result.error);
    } catch (err) {
      console.error('revealSessionsDir failed:', err);
    }
  };

  const confirmRedownload = async (id: string) => {
    setRedownloadOpenId(null);
    try {
      await redownloadSessionAudio(id);
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'Failed to start re-download');
    }
    await refresh();
    await onChanged([]);
  };

  const executeDialog = async () => {
    if (!dialog || running) return;
    setRunning(true);
    const failures: string[] = [];
    const processed: string[] = [];
    const deletedSessionIds: string[] = [];
    try {
      // Re-check against the latest snapshot: a session may have started working since the dialog opened.
      const latest = (await refresh()) ?? summary;
      const activeNow = new Set((latest?.sessions ?? []).filter(isActiveEntry).map((s) => s.id));
      for (const id of dialog.ids) {
        if (activeNow.has(id)) {
          failures.push('Session is busy — wait until it finishes');
          continue;
        }
        try {
          if (dialog.mode === 'sessions') {
            await deleteSession(id);
            deletedSessionIds.push(id);
          } else if (dialog.mode === 'audio') {
            await deleteSessionAudio(id);
          } else {
            await deleteSessionAudio(id, dialog.file.name);
          }
          processed.push(id);
        } catch (err) {
          failures.push((err as Error).message || 'Request failed');
        }
      }
    } finally {
      setRunning(false);
    }
    setError(failures.length > 0 ? `Could not delete ${failures.length} item(s): ${failures[0]}` : null);
    setSelected((prev) => {
      const next = new Set(prev);
      processed.forEach((id) => next.delete(id));
      return next;
    });
    setDialog(null);
    const after = await refresh();
    if (failures.length > 0 && after) {
      setError(`Could not delete ${failures.length} item(s): ${failures[0]}`);
    }
    await onChanged(deletedSessionIds);
  };

  const dialogEntries = dialog ? dialog.ids.map((id) => byId.get(id)).filter((e): e is SessionStorageEntry => !!e) : [];
  const dialogAudioBytes = dialogEntries.reduce((sum, e) => sum + e.audioBytes, 0);
  const dialogTotalBytes = dialogEntries.reduce((sum, e) => sum + e.totalBytes, 0);

  const renderDialog = () => {
    if (!dialog) return null;
    const n = dialog.ids.length;
    let title: string;
    let body: string;
    let note: string | null = null;
    let breakdown = false;
    let okLabel = 'Delete';
    let okClass = 'archive-btn archive-btn--danger-outline';
    if (dialog.mode === 'sessions') {
      title = `Delete ${n} session${n === 1 ? '' : 's'}?`;
      body = `This permanently deletes the selected sessions and frees ${formatBytes(dialogTotalBytes)}.`;
      breakdown = true;
      okClass = 'archive-btn archive-btn--danger';
    } else if (dialog.mode === 'audio') {
      title = `Delete audio from ${n} session${n === 1 ? '' : 's'}?`;
      body = `Audio files (source + WAV) are removed. Transcripts are kept. Frees ${formatBytes(dialogAudioBytes)}.`;
      if (dialogEntries.some((e) => e.sourceUrl)) note = 'Sessions from links can re-download their audio later.';
      okLabel = 'Delete Audio';
    } else {
      title = `Delete ${dialog.file.name}?`;
      body = `Frees ${formatBytes(dialog.file.bytes)}. The transcript is kept.`;
    }
    return (
      <div
        className="archive-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget && !running) setDialog(null);
        }}
      >
        <div className="archive-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-dialog-title">
          <h3 id="archive-dialog-title">{title}</h3>
          <p>{body}</p>
          {breakdown && (
            <div className="archive-breakdown">
              <div><span>Audio files</span><span>{formatBytes(dialogAudioBytes)}</span></div>
              <div><span>Transcripts &amp; other</span><span>{formatBytes(Math.max(0, dialogTotalBytes - dialogAudioBytes))}</span></div>
            </div>
          )}
          {note && <p className="archive-dialog-note">{note}</p>}
          <div className="archive-dialog-acts">
            <button type="button" className="archive-btn" onClick={() => setDialog(null)} disabled={running}>Cancel</button>
            <button type="button" className={okClass} onClick={() => void executeDialog()} disabled={running}>
              {running ? 'Deleting...' : okLabel}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderRow = (entry: SessionStorageEntry) => {
    const disabled = isActiveEntry(entry);
    const open = !disabled && expanded.has(entry.id);
    const isSelected = selected.has(entry.id);
    const src = sourceLabel(entry);
    const hasLiveAudio = entry.files.some((f) => f.kind === 'audio' && !f.deleted);
    const redownloadFailed = entry.audioDeleted && !!entry.error && entry.status === 'completed';
    const rowClass = ['archive-row', disabled ? 'archive-row--disabled' : '', isSelected ? 'archive-row--selected' : '']
      .filter(Boolean)
      .join(' ');

    return (
      <div className={rowClass} key={entry.id}>
        <div className="archive-cols archive-row-main" onClick={() => { if (!disabled) toggleExpanded(entry.id); }}>
          <span className="archive-c-cb" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="archive-cb"
              checked={isSelected}
              disabled={disabled}
              onChange={(e) => toggleSelected(entry.id, e.target.checked)}
              aria-label={`Select ${entry.title}`}
            />
          </span>
          <span className="archive-arrow">{open ? '▾' : '▸'}</span>
          <span className="archive-row-title" title={entry.title}>
            {entry.title}
            {disabled && (
              <span className={`archive-badge archive-badge--${entry.status === 'uploading' ? 'uploading' : 'transcribing'}`}>
                {entry.status === 'uploading' ? 'Uploading' : 'Transcribing'}
              </span>
            )}
            {!disabled && entry.audioDeleted && <span className="archive-muted">Audio deleted</span>}
            {!disabled && !entry.audioDeleted && entry.wavAutoDeleted && <span className="archive-muted">WAV auto-deleted</span>}
            {!disabled && redownloadFailed && <span className="archive-muted">Re-download failed</span>}
          </span>
          <span className="archive-date">{new Date(entry.createdAt).toLocaleDateString()}</span>
          <span className={src.className}>{src.text}</span>
          <span className={`archive-size${entry.totalBytes === 0 ? ' archive-size--zero' : ''}`}>{formatBytes(entry.totalBytes)}</span>
        </div>
        {open && (
          <div className="archive-detail">
            {entry.files.map((file) => (
              <div className={`archive-file${file.deleted ? ' archive-file--gone' : ''}`} key={`${file.name}${file.deleted ? ':deleted' : ''}`}>
                <span className="archive-fname" title={file.name}>{file.name}</span>
                <span className="archive-fsize">
                  {file.deleted ? <span className={file.auto ? 'archive-file-auto-tag' : 'archive-file-deleted-tag'}>{file.auto ? 'auto-deleted' : 'deleted'}</span> : formatBytes(file.bytes)}
                </span>
                <span className="archive-fnote">{fileNote(file)}</span>
                {!file.deleted && file.kind === 'audio' ? (
                  <button
                    type="button"
                    className="archive-file-del"
                    onClick={() => setDialog({ mode: 'file', ids: [entry.id], file })}
                  >
                    Delete
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
            <div className="archive-detail-actions">
              {hasLiveAudio && (
                <button
                  type="button"
                  className="archive-btn archive-btn--small archive-btn--accent-outline"
                  onClick={() => setDialog({ mode: 'audio', ids: [entry.id] })}
                >
                  Delete audio
                </button>
              )}
              <button
                type="button"
                className="archive-btn archive-btn--small archive-btn--danger-outline"
                onClick={() => setDialog({ mode: 'sessions', ids: [entry.id] })}
              >
                Delete session
              </button>
              {entry.audioDeleted && entry.sourceUrl && (
                <button
                  type="button"
                  className="archive-btn archive-btn--small archive-btn--accent-outline"
                  onClick={() => setRedownloadOpenId((prev) => (prev === entry.id ? null : entry.id))}
                >
                  Re-download
                </button>
              )}
            </div>
            {entry.audioDeleted && !entry.sourceUrl && (
              <div className="archive-note-line">Audio was deleted — transcript only</div>
            )}
            {redownloadOpenId === entry.id && entry.sourceUrl && (
              <div className="archive-redl-confirm">
                Re-download from <span className="archive-url">{entry.sourceUrl}</span>? This will use ~{formatBytes(estimateRedownloadBytes(entry))}.
                <div className="archive-acts">
                  <button type="button" className="archive-btn archive-btn--small archive-btn--primary" onClick={() => void confirmRedownload(entry.id)}>Confirm</button>
                  <button type="button" className="archive-btn archive-btn--small" onClick={() => setRedownloadOpenId(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="archive-page">
      <button type="button" className="archive-back" onClick={onBack}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><polyline points="10 3 5 8 10 13" /></svg>
        Back
      </button>

      <h1 className="archive-title">Archive</h1>

      {isRecording && (
        <button type="button" className="recording-active-banner" onClick={onReturnToRecording}>
          <span className="recording-dot" aria-hidden="true" />
          Recording in progress — click to return
        </button>
      )}

      {error && <div className="archive-error" role="alert">{error}</div>}

      <div className="archive-card">
        <div className="archive-section-title">Storage</div>
        <div className="archive-info-row">
          <span className="archive-info-label">Data directory</span>
          {summary && window.august?.revealSessionsDir ? (
            <button type="button" className="archive-path" title="Open in file explorer" onClick={() => void openReveal()}>
              {summary.sessionsDir}
            </button>
          ) : (
            <span className="archive-path">{summary?.sessionsDir ?? ''}</span>
          )}
        </div>
        <div className="archive-info-row">
          <span className="archive-info-label">Total size</span>
          <span>
            <span className="archive-term">{formatBytes(summary?.totalBytes ?? 0)}</span> across{' '}
            <span className="archive-term">{sessions.length}</span> sessions
          </span>
        </div>
      </div>

      {!summary && !error && <div className="archive-loading">Loading...</div>}

      {summary && (
        <div className="archive-list">
          <div className="archive-cols archive-list-head">
            <span>
              <input
                type="checkbox"
                className="archive-cb"
                id="archive-select-all"
                ref={selectAllRef}
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={(e) => toggleAll(e.target.checked)}
                aria-label="Select all"
              />
            </span>
            <span className="archive-h-col" />
            <span><label htmlFor="archive-select-all">Select all</label></span>
            <span className="archive-h-col">Date</span>
            <span className="archive-h-col">Source</span>
            <span className="archive-h-col archive-right">Size</span>
          </div>
          {sessions.length === 0 ? <div className="archive-empty">No sessions yet.</div> : sessions.map(renderRow)}
        </div>
      )}

      {selected.size > 0 && (
        <div className="archive-bulk">
          <div className="archive-bulk-count">
            {selected.size} selected <span>({formatBytes(selectedBytes)})</span>
          </div>
          <div className="archive-acts">
            <button
              type="button"
              className="archive-btn archive-btn--accent-outline"
              onClick={() => setDialog({ mode: 'audio', ids: [...selected] })}
            >
              Delete Audio Only
            </button>
            <button
              type="button"
              className="archive-btn archive-btn--danger-outline"
              onClick={() => setDialog({ mode: 'sessions', ids: [...selected] })}
            >
              Delete Sessions
            </button>
          </div>
        </div>
      )}

      {renderDialog()}
    </div>
  );
};

export default ArchivePage;
