import React, { useMemo, useState, useRef, useEffect } from 'react';
import type { ActionItem, ActionItemsFile, CorrectionItem, CorrectionStatus, SessionMetadata } from '../types';
import { sendActionItemsToPraxis, addActionItem, deleteActionItem, fetchActionItems, fetchCorrectedTranscript, fetchCorrections, fetchGroqTextStatus, fetchLlmStatus, setAllCorrectionsStatus, setCorrectionStatus, updateActionItem } from '../api';
import PraxisModal from './PraxisModal';
import ConfidenceBadge from './ConfidenceBadge';
import ActionItemsPanel, { type ActionItemSourceNav } from './ActionItemsPanel';
import { MSG_TRANSCRIPT_NOT_READY, findBestLine, formatClock, scrollBehavior } from '../services/actionItemSource';
import { useSessionAudioPlayer } from '../services/sessionAudioPlayer';
import type { PraxisProject, UserPreferences } from '../services/preferences';

interface TranscriptViewProps {
  session: SessionMetadata;
  transcript: string;
  onRetranscribe?: (language?: string, boost?: boolean) => Promise<void>;
  onCancel?: () => Promise<void>;
  ffmpegAvailable?: boolean;
  praxisProjects?: PraxisProject[];
  praxisDefaultPromptCustom?: boolean;
  praxisRecentPaths?: string[];
  onPraxisPreferenceChange?: (patch: Partial<UserPreferences>) => void | Promise<void>;
  onRename?: (title: string) => Promise<void>;
  onRedownload?: () => Promise<void>;
}

interface ParsedLine {
  timestamp: string | null;
  role: string | null;
  text: string;
}

const TIMESTAMP_LINE = /^\[(\d{2}:\d{2}:\d{2})\]\s?(?:\[(Me|Them)\]\s)?(.*)$/;

function parseTranscript(markdown: string): ParsedLine[] {
  const lines = markdown.split('\n');
  const result: ParsedLine[] = [];

  for (const line of lines) {
    // AUG-166: the trailing Action items section is rendered by the panel, not as transcript lines.
    if (/^## Action items\s*$/.test(line)) break;
    if (!line.trim()) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('- Date:') || line.startsWith('- Duration:')) continue;

    const match = line.match(TIMESTAMP_LINE);
    if (match) {
      result.push({ timestamp: match[1], role: match[2] || null, text: match[3] });
    } else {
      result.push({ timestamp: null, role: null, text: line });
    }
  }

  return result;
}

interface DiffPart { text: string; changed: boolean; }

/// AUG-163: mirror of server applyItemsToText — each accepted fix replaces the first occurrence of its segment text.
function applyItemsToText(text: string, items: CorrectionItem[]): string {
  let out = text;
  for (const item of items) {
    if (item.status !== 'accepted' || !item.original) continue;
    const at = out.indexOf(item.original);
    if (at < 0) continue;
    out = out.slice(0, at) + item.suggested + out.slice(at + item.original.length);
  }
  return out;
}

/// AUG-163: word-level diff (LCS over whitespace-split tokens). `oldParts` marks removed tokens, `newParts` inserted ones.
function diffWords(a: string, b: string): { oldParts: DiffPart[]; newParts: DiffPart[] } {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldParts: DiffPart[] = [];
  const newParts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      oldParts.push({ text: x[i], changed: false });
      newParts.push({ text: y[j], changed: false });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      oldParts.push({ text: x[i++], changed: true });
    } else {
      newParts.push({ text: y[j++], changed: true });
    }
  }
  while (i < x.length) oldParts.push({ text: x[i++], changed: true });
  while (j < y.length) newParts.push({ text: y[j++], changed: true });
  return { oldParts, newParts };
}

function renderDiffParts(parts: DiffPart[], tag: 'del' | 'ins'): React.ReactNode[] {
  return parts.map((p, i) => {
    const sep = i > 0 ? ' ' : '';
    return p.changed
      ? <React.Fragment key={i}>{sep}{tag === 'del' ? <del className="correction-del">{p.text}</del> : <ins className="correction-ins">{p.text}</ins>}</React.Fragment>
      : <React.Fragment key={i}>{sep}{p.text}</React.Fragment>;
  });
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function languageLabel(language: string): string {
  switch (language) {
    case 'en':
      return 'English';
    case 'ru':
      return 'Russian';
    case 'auto':
    default:
      return 'Auto-detect';
  }
}

function timestampToSeconds(ts: string): number {
  const [h, m, s] = ts.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function secondsToSrtTimestamp(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},000`;
}

function generateTextOnly(lines: ParsedLine[]): string {
  return lines.map(l => l.role ? `[${l.role}] ${l.text}` : l.text).join('\n');
}

function generateTxtWithTimestamps(lines: ParsedLine[]): string {
  return lines
    .map(l => {
      const rolePrefix = l.role ? `[${l.role}] ` : '';
      return l.timestamp ? `[${l.timestamp}] ${rolePrefix}${l.text}` : l.text;
    })
    .join('\n');
}

function generateSrt(lines: ParsedLine[]): string {
  const timestamped = lines.filter(l => l.timestamp !== null);
  if (timestamped.length === 0) return '';

  return timestamped
    .map((line, i) => {
      const startSec = timestampToSeconds(line.timestamp!);
      const endSec =
        i < timestamped.length - 1
          ? timestampToSeconds(timestamped[i + 1].timestamp!)
          : startSec + 5;
      const start = secondsToSrtTimestamp(startSec);
      const end = secondsToSrtTimestamp(endSec);
      return `${i + 1}\n${start} --> ${end}\n${line.role ? `[${line.role}] ` : ''}${line.text}`;
    })
    .join('\n\n');
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const CHRONO_CIRC = 2 * Math.PI * 88;

function generateTicks(): React.ReactNode[] {
  const ticks: React.ReactNode[] = [];
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * 2 * Math.PI;
    const major = i % 5 === 0;
    const r1 = major ? 96 : 98;
    const r2 = 104;
    ticks.push(
      <line
        key={i}
        style={{ '--i': i } as React.CSSProperties}
        x1={110 + r1 * Math.cos(angle)}
        y1={110 + r1 * Math.sin(angle)}
        x2={110 + r2 * Math.cos(angle)}
        y2={110 + r2 * Math.sin(angle)}
        className="chrono-tick"
        strokeWidth={major ? 1.5 : 1}
      />
    );
  }
  return ticks;
}

const CHRONO_TICKS = generateTicks();

function formatChronoFull(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}

/// AUG-189: user words for the server's post-whisper stage; unknown or missing -> "finishing".
const STAGE_LABELS: Record<string, string> = {
  cleaning: 'cleaning up',
  checking: 'checking the text',
  correcting: 'suggesting fixes',
  saving: 'saving',
};
function stageLabel(stage: string | undefined): string {
  return (stage && STAGE_LABELS[stage]) || 'finishing';
}

/// AUG-210: session naming. The server applies the same limit and normalisation.
const TITLE_MAX_CHARS = 120;
const RENAME_ERROR = 'Could not save the name. Try again.';

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS).trim();
}

/// Sessions whose naming pop-up was answered or closed. Module-level on purpose: hidden until the app restarts.
const closedNamePopups = new Set<string>();

const PencilIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5l4 4L8 20l-5 1 1-5z" />
  </svg>
);

/// AUG-210: click-to-edit header title. Enter and blur save, Esc restores; empty or unchanged input sends nothing.
/// Rendered with key={session.id}: on a session switch the unmount commits the draft for the session it was typed for.
const EditableTitle: React.FC<{ session: SessionMetadata; onRename?: (title: string) => Promise<void> }> = ({ session, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(false);
  const savingRef = useRef(false);
  const skipBlurRef = useRef(false);
  // The server may still replace the title of a link session while it downloads.
  const canEdit = !!onRename && session.status !== 'uploading';
  const latest = useRef({ editing, draft, title: session.title, onRename });
  latest.current = { editing, draft, title: session.title, onRename };

  useEffect(() => () => {
    const l = latest.current;
    const next = normalizeTitle(l.draft);
    if (l.editing && !savingRef.current && l.onRename && next && next !== l.title) void l.onRename(next).catch(() => {});
  }, []);

  const start = () => {
    if (!canEdit) return;
    skipBlurRef.current = false;
    setDraft(session.title);
    setFailed(false);
    setEditing(true);
  };

  const cancel = () => {
    skipBlurRef.current = true;
    setEditing(false);
    setFailed(false);
  };

  const commit = async () => {
    if (savingRef.current || !onRename) return;
    const next = normalizeTitle(draft);
    if (!next || next === session.title) {
      setEditing(false);
      setFailed(false);
      return;
    }
    savingRef.current = true;
    try {
      await onRename(next);
      setEditing(false);
      setFailed(false);
    } catch {
      setFailed(true); // stays in edit mode with the typed text
    } finally {
      savingRef.current = false;
    }
  };

  if (editing) {
    return (
      <div className="title-edit">
        <input
          type="text"
          className={`title-edit-input${failed ? ' title-edit-input--error' : ''}`}
          value={draft}
          maxLength={TITLE_MAX_CHARS}
          aria-label="Session name"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => { setDraft(e.target.value); setFailed(false); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              e.stopPropagation(); // must not reach the overlay Esc handler in App
              cancel();
            }
          }}
          onBlur={() => {
            if (skipBlurRef.current) { skipBlurRef.current = false; return; }
            void commit();
          }}
        />
        {failed && <div className="title-edit-error" role="alert">{RENAME_ERROR}</div>}
      </div>
    );
  }

  if (!canEdit) return <h2 className="transcript-circuit-title">{session.title}</h2>;

  return (
    <h2
      className="transcript-circuit-title transcript-circuit-title--editable"
      title="Click to rename"
      tabIndex={0}
      onClick={start}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } }}
    >
      <span className="title-edit-text">{session.title}</span>
      <span className="title-edit-pen" aria-hidden="true"><PencilIcon /></span>
    </h2>
  );
};

/// AUG-210: corner pop-up on the timer page. Never takes focus on its own; Save / Enter rename, Later / ✕ / Esc hide it
/// for this session. A typed but unsaved name is committed when the pop-up unmounts (transcription finished, session switch).
const NamePopup: React.FC<{ session: SessionMetadata; onRename: (title: string) => Promise<void>; onClose: () => void }> = ({ session, onRename, onClose }) => {
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [textModelOn, setTextModelOn] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const closedRef = useRef(false);
  const latest = useRef({ draft, title: session.title, onRename });
  latest.current = { draft, title: session.title, onRename };

  // The waiting line is shown only when a text model can actually produce a suggestion.
  useEffect(() => {
    let alive = true;
    Promise.all([fetchLlmStatus().catch(() => null), fetchGroqTextStatus().catch(() => null)]).then(([llm, groq]) => {
      if (alive) setTextModelOn((!!llm && llm.enabled && llm.install === 'ready') || !!groq?.enabled);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => () => {
    if (closedRef.current) return;
    const l = latest.current;
    const next = normalizeTitle(l.draft);
    if (next && next !== l.title) void l.onRename(next).catch(() => {});
  }, []);

  const close = () => {
    closedRef.current = true;
    onClose();
  };

  const save = async () => {
    if (saving) return;
    const next = normalizeTitle(draft);
    if (!next) return;
    if (next === session.title) { close(); return; }
    setSaving(true);
    try {
      await onRename(next);
      close();
    } catch {
      setFailed(true); // keeps the typed text
      setSaving(false);
    }
  };

  const suggestion = session.suggestedTitle;

  return (
    <div className="name-popup" role="dialog" aria-label="Name this meeting">
      <div className="name-popup-head">
        <span className="name-popup-title">Name this meeting</span>
        <button type="button" className="name-popup-close" aria-label="Close" onClick={close}>✕</button>
      </div>
      <input
        ref={inputRef}
        type="text"
        className={`name-popup-input${failed ? ' name-popup-input--error' : ''}`}
        value={draft}
        maxLength={TITLE_MAX_CHARS}
        placeholder={session.title}
        aria-label="Meeting name"
        onChange={(e) => { setDraft(e.target.value); setFailed(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.stopPropagation(); // must not reach the overlay Esc handler in App
            close();
          }
        }}
      />
      {failed && <div className="name-popup-error" role="alert">{RENAME_ERROR}</div>}
      {suggestion ? (
        <div className="name-popup-sug">
          <button
            type="button"
            className="name-popup-chip"
            onClick={() => { setDraft(suggestion.slice(0, TITLE_MAX_CHARS)); setFailed(false); inputRef.current?.focus(); }}
          >
            <span className="name-popup-chip-key">Suggested</span>
            <span aria-hidden="true">·</span>
            <span className="name-popup-chip-name">{suggestion}</span>
          </button>
          <div className="name-popup-help">Click to use it</div>
        </div>
      ) : textModelOn ? (
        <div className="name-popup-sug name-popup-wait">
          <span className="name-popup-dots" aria-hidden="true"><i /><i /><i /></span>
          A suggested name will appear when the text is ready
        </div>
      ) : null}
      <div className="name-popup-btns">
        <button type="button" className="name-popup-btn name-popup-btn--primary" onClick={() => void save()} disabled={saving}>Save</button>
        <button type="button" className="name-popup-btn" onClick={close}>Later</button>
      </div>
    </div>
  );
};

const ChronoRing: React.FC<{ session: SessionMetadata }> =({ session }) => {
  const [remainMs, setRemainMs] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);

  const estimatedTotalMs = (session.estimatedDuration ?? 0) * 1000;
  const startedAtMs = session.transcriptionStartedAt
    ? new Date(session.transcriptionStartedAt).getTime()
    : 0;

  useEffect(() => {
    if (!startedAtMs || estimatedTotalMs <= 0) return;

    const tick = () => {
      const now = Date.now();
      const elapsed = now - startedAtMs;
      const remain = Math.max(0, estimatedTotalMs - elapsed);
      const prog = Math.min(elapsed / estimatedTotalMs, 1);

      setElapsedMs(elapsed);
      setRemainMs(remain);
      setProgress(prog);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [startedAtMs, estimatedTotalMs]);

  // AUG-189: a set processingStage means whisper is done, so the ring is zeroed even if the ETA guess has not run out.
  const forcedZero = !!session.processingStage;
  const isZeroed = (remainMs <= 0 && progress >= 1) || forcedZero;
  const shownProgress = isZeroed ? 1 : progress;
  const offset = CHRONO_CIRC * (1 - shownProgress);
  const isLastMinute = !isZeroed && remainMs < 60000 && remainMs > 0;
  const isProcessing = isZeroed && session.status === 'transcribing';

  // AUG-189: 00:00:00 holds for 2 s after zero, then fades out and the server stage fades in inside the ring.
  const [showStage, setShowStage] = useState(false);
  useEffect(() => {
    if (!isProcessing) { setShowStage(false); return; }
    const t = setTimeout(() => setShowStage(true), 2000);
    return () => clearTimeout(t);
  }, [isProcessing]);

  const phaseClass = isZeroed
    ? 'chrono-phase-zeroed'
    : isLastMinute
      ? 'chrono-phase-red'
      : '';

  const finishTime = new Date(Date.now() + remainMs);
  const finishStr = `${String(finishTime.getHours()).padStart(2, '0')}:${String(finishTime.getMinutes()).padStart(2, '0')}`;

  if (!startedAtMs || estimatedTotalMs <= 0) {
    return (
      <div className="transcription-progress-wrapper">
        <div className="transcription-progress-bar">
          <div className="transcription-progress-fill" />
        </div>
        <p className="transcription-status-text">{session.processingStage ? `Still working — ${stageLabel(session.processingStage)}` : 'Transcribing audio...'}</p>
      </div>
    );
  }

  return (
    <div className={`chrono-container ${phaseClass}${isProcessing ? ' chrono-processing' : ''}`}>
      {isZeroed && (
        <div className="chrono-exterminatus">
          <span className="chrono-ext-line" />
          <span className="chrono-ext-text">Almost done! Just a second more...</span>
          <span className="chrono-ext-line chrono-ext-line--bottom" />
        </div>
      )}

      <div className="chrono-ring-wrap">
        <svg className="chrono-ring-svg" viewBox="0 0 220 220">
          <g>{CHRONO_TICKS}</g>
          <circle cx="110" cy="110" r="88" className="chrono-track" />
          <circle
            cx="110" cy="110" r="88"
            className="chrono-glow"
            strokeDasharray={CHRONO_CIRC}
            strokeDashoffset={offset}
          />
          <circle
            cx="110" cy="110" r="88"
            className="chrono-fill"
            strokeDasharray={CHRONO_CIRC}
            strokeDashoffset={offset}
          />
          <circle cx="110" cy="110" r="88" className="chrono-pulse-ring" />
          <circle cx="110" cy="110" r="88" className="chrono-pulse-ring chrono-pulse-ring--2" />
          <circle cx="110" cy="110" r="88" className="chrono-pulse-ring--3 chrono-pulse-ring" />
        </svg>
        <div className="chrono-center">
          <div className={`chrono-center-layer${showStage ? ' is-hidden' : ''}`}>
            <div className="chrono-label">remaining</div>
            <div className="chrono-digits">{isZeroed ? '00:00:00' : formatChronoFull(remainMs)}</div>
            <div className="chrono-pct">{Math.round(shownProgress * 100)}%</div>
          </div>
          {isProcessing && (
            <div className={`chrono-center-layer chrono-center-stage${showStage ? ' is-visible' : ''}`} aria-live="polite">
              <div className="chrono-label">status</div>
              <div className="chrono-stage-text">{stageLabel(session.processingStage)}</div>
              <span className="chrono-blinkers" aria-hidden="true"><i /><i /><i /></span>
              <div className="chrono-pct">100%</div>
            </div>
          )}
        </div>
      </div>

      <div className="chrono-meta">
        <div className="chrono-meta-item">
          <div className="chrono-meta-dot" />
          <span className="chrono-meta-label">Elapsed</span>
          <span className="chrono-meta-val">{formatDuration(Math.floor(elapsedMs / 1000))}</span>
        </div>
        <div className="chrono-meta-item">
          <span className="chrono-meta-label">Audio</span>
          <span className="chrono-meta-val">{formatDuration(session.duration)}</span>
        </div>
      </div>

      {!isZeroed && (
        <div className="chrono-info-bar">
          <div className="chrono-info-dot" />
          <span className="chrono-info-text">
            Завершение в <span className="chrono-info-time">{finishStr}</span>
          </span>
        </div>
      )}
    </div>
  );
};

const TranscriptView: React.FC<TranscriptViewProps> = ({ session, transcript, onRetranscribe, onCancel, ffmpegAvailable = false, praxisProjects, praxisDefaultPromptCustom, praxisRecentPaths, onPraxisPreferenceChange, onRename, onRedownload }) => {
  const [feedbackText, setFeedbackText] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const retranscribeRef = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [boostEnabled, setBoostEnabled] = useState(false);
  const [failedMenuOpen, setFailedMenuOpen] = useState(false);
  const failedMenuRef = useRef<HTMLDivElement>(null);
  const [showPraxisModal, setShowPraxisModal] = useState(false);
  const [praxisExport, setPraxisExport] = useState<{ ids: string[]; mode: 'separate' | 'common' } | null>(null);
  const [redownloading, setRedownloading] = useState(false);
  const [corrections, setCorrections] = useState<CorrectionItem[]>([]);
  const [actionItems, setActionItems] = useState<ActionItemsFile | null>(null);
  const [correctionBusy, setCorrectionBusy] = useState<number | null>(null);
  const audioDeleted = !!session.audioDeletedAt;
  // AUG-210: the naming pop-up shows only while the session still has its auto title.
  const [, bumpNamePopup] = useState(0);
  const showNamePopup = !!onRename
    && (session.status === 'preparing' || session.status === 'transcribing')
    && session.titleSource === 'auto'
    && !closedNamePopups.has(session.id);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!retranscribeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (retranscribeRef.current && !retranscribeRef.current.contains(e.target as Node)) {
        setRetranscribeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [retranscribeOpen]);

  useEffect(() => {
    if (!failedMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (failedMenuRef.current && !failedMenuRef.current.contains(e.target as Node)) {
        setFailedMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [failedMenuOpen]);

  const handleRetranscribe = async (language?: string) => {
    if (!onRetranscribe || retrying) return;
    setRetrying(true);
    setRetranscribeOpen(false);
    try {
      await onRetranscribe(language, boostEnabled);
    } finally {
      setRetrying(false);
    }
  };

  const handleFailedRetranscribe = async (language?: string) => {
    if (!onRetranscribe || retrying) return;
    setRetrying(true);
    setFailedMenuOpen(false);
    try {
      await onRetranscribe(language, boostEnabled);
    } finally {
      setRetrying(false);
    }
  };

  const handleRedownload = async () => {
    if (!onRedownload || redownloading) return;
    setRedownloading(true);
    try {
      await onRedownload();
    } finally {
      setRedownloading(false);
    }
  };

  const handleCancel = async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  const parsedLines = useMemo(() => parseTranscript(transcript), [transcript]);

  // AUG-163: suggested meaning fixes, keyed by utterance index (k-th timestamp line).
  useEffect(() => {
    if (session.status !== 'completed') { setCorrections([]); return; }
    let alive = true;
    fetchCorrections(session.id)
      .then((file) => { if (alive) setCorrections(file.items); })
      .catch(() => { if (alive) setCorrections([]); });
    return () => { alive = false; };
  }, [session.id, session.status, transcript]);

  // AUG-165: action items collected during a live recording (any session status).
  // AUG-214: re-read when the status changes — the server sets anchor.line when it writes the transcript.
  useEffect(() => {
    let alive = true;
    fetchActionItems(session.id)
      .then((f) => { if (alive) setActionItems(f); })
      .catch(() => { if (alive) setActionItems(null); });
    return () => { alive = false; };
  }, [session.id, session.status]);

  const handleActionEdit = (itemId: string, patch: { text?: string; owner?: string; context?: string }) => {
    updateActionItem(session.id, itemId, patch).then(setActionItems).catch(() => {});
  };
  const handleActionAdd = (text: string, owner: string) => {
    addActionItem(session.id, { text, owner: owner || undefined }).then(setActionItems).catch(() => {});
  };
  const handleActionDelete = (itemId: string) => {
    if (audio.playback?.itemId === itemId) audio.stop();
    if (sourceHl?.itemId === itemId) setSourceHl(null);
    deleteActionItem(session.id, itemId).then(setActionItems).catch(() => {});
  };

  const correctionsByIndex = useMemo(() => {
    const map = new Map<number, CorrectionItem[]>();
    for (const c of corrections) map.set(c.index, [...(map.get(c.index) ?? []), c]);
    return map;
  }, [corrections]);
  const hasAcceptedCorrection = corrections.some((c) => c.status === 'accepted');
  const pendingCount = corrections.filter((c) => c.status === 'pending').length;
  const utteranceIndexByLine = useMemo(() => {
    let k = -1;
    return parsedLines.map((l) => (l.timestamp ? ++k : -1));
  }, [parsedLines]);

  // AUG-214: jump from an action item to its transcript line and back. anchor.line is an utterance index
  // (k-th timestamp line); accepted fixes change a line's text, never the index, so it holds for the text shown.
  const [sourceHl, setSourceHl] = useState<{ itemId: string; index: number; n: number } | null>(null);
  const [itemReveal, setItemReveal] = useState<{ id: string; n: number } | null>(null);
  const [flashItemId, setFlashItemId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | undefined>(undefined);
  const linesRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => window.clearTimeout(flashTimerRef.current), []);
  useEffect(() => { setSourceHl(null); }, [session.id, transcript]);
  const lineIndexByUtterance = useMemo(() => {
    const map: number[] = [];
    utteranceIndexByLine.forEach((k, i) => { if (k >= 0) map[k] = i; });
    return map;
  }, [utteranceIndexByLine]);
  const sourceIndex = sourceHl?.index ?? -1;
  const sourceN = sourceHl?.n ?? 0;
  useEffect(() => {
    if (sourceIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      linesRef.current?.querySelector<HTMLElement>('.transcript-line--source')?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    });
    return () => cancelAnimationFrame(frame);
  }, [sourceIndex, sourceN]);
  const showSourceLine = (item: ActionItem, index: number) => {
    setFlashItemId(null);
    setSourceHl((prev) => ({ itemId: item.id, index, n: (prev?.n ?? 0) + 1 }));
  };
  const handleSourceBack = () => {
    if (!sourceHl) return;
    const id = sourceHl.itemId;
    setSourceHl(null);
    setItemReveal((r) => ({ id, n: (r?.n ?? 0) + 1 }));
    setFlashItemId(id);
    window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashItemId(null), 2000);
  };
  const transcriptReady = session.status === 'completed';
  // AUG-215: play from an action item's moment. The key changes when audio is deleted, auto-deleted or re-downloaded.
  const audioKey = `${session.audioDeletedAt ?? ''}|${session.wavAutoDeletedAt ?? ''}|${(session.audioDeletedFiles ?? []).length}`;
  const audio = useSessionAudioPlayer(session.id, transcriptReady, audioKey);
  const sourceNav: ActionItemSourceNav = {
    target: (item) => {
      if (!transcriptReady) return item.anchor ? 'jump' : item.manual ? 'none' : 'find';
      const line = item.anchor?.line;
      if (line !== undefined && lineIndexByUtterance[line] !== undefined) return 'jump';
      return item.manual ? 'none' : 'find';
    },
    blocked: () => (transcriptReady
      ? null
      : session.status === 'failed'
        ? { text: 'There is no transcript for this session.' }
        : { text: MSG_TRANSCRIPT_NOT_READY, warn: true }),
    go: (item) => {
      const line = item.anchor?.line;
      const index = line !== undefined ? lineIndexByUtterance[line] : undefined;
      if (index !== undefined) showSourceLine(item, index);
    },
    find: (item) => {
      const index = findBestLine(item.text, parsedLines.map((l) => (l.timestamp ? l.text : '')));
      if (index < 0) return false;
      showSourceLine(item, index);
      return true;
    },
    canPlay: (item) => audio.available && !item.manual && typeof item.anchor?.atMs === 'number',
    play: (item) => {
      const atMs = item.anchor?.atMs;
      if (typeof atMs !== 'number') return;
      const line = item.anchor?.line;
      const index = line !== undefined ? lineIndexByUtterance[line] : undefined;
      if (index !== undefined) showSourceLine(item, index);
      audio.playFrom(item.id, atMs);
    },
    ownerId: sourceHl?.itemId ?? flashItemId,
    reveal: itemReveal,
  };

  const handleCorrection = async (item: CorrectionItem, status: CorrectionStatus) => {
    if (correctionBusy !== null) return;
    setCorrectionBusy(item.id);
    try {
      const file = await setCorrectionStatus(session.id, item.id, status);
      setCorrections(file.items);
    } catch {
      // keep the current state; the user can retry
    } finally {
      setCorrectionBusy(null);
    }
  };

  const handleAcceptAll = async () => {
    if (correctionBusy !== null) return;
    setCorrectionBusy(-1);
    try {
      setCorrections((await setAllCorrectionsStatus(session.id, 'accepted')).items);
    } catch {
      // keep the current state; the user can retry
    } finally {
      setCorrectionBusy(null);
    }
  };

  const handleDownloadCorrectedTxt = async () => {
    setDropdownOpen(false);
    try {
      const md = await fetchCorrectedTranscript(session.id);
      const safeName = session.title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'transcript';
      downloadFile(generateTxtWithTimestamps(parseTranscript(md)), `${safeName}-corrected.txt`, 'text/plain');
    } catch {
      // download failed; nothing to show
    }
  };

  const showFeedback = (text: string) => {
    setFeedbackText(text);
    setDropdownOpen(false);
    setTimeout(() => setFeedbackText(null), 2000);
  };

  const handleCopyWithTimestamps = async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      showFeedback('Copied!');
    } catch {
      // clipboard API unavailable
    }
  };

  const handleCopyTextOnly = async () => {
    try {
      const text = generateTextOnly(parsedLines);
      await navigator.clipboard.writeText(text);
      showFeedback('Copied!');
    } catch {
      // clipboard API unavailable
    }
  };

  const handleDownloadTxt = () => {
    const content = generateTxtWithTimestamps(parsedLines);
    const safeName = session.title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'transcript';
    downloadFile(content, `${safeName}.txt`, 'text/plain');
    setDropdownOpen(false);
  };

  const handleDownloadSrt = () => {
    const content = generateSrt(parsedLines);
    const safeName = session.title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'transcript';
    downloadFile(content, `${safeName}.srt`, 'application/x-subrip');
    setDropdownOpen(false);
  };

  const handleSendToPraxis = () => {
    setDropdownOpen(false);
    setShowPraxisModal(true);
  };

  return (
    <div className="transcript-view">
      <div className="transcript-circuit-header">
        <div className="transcript-circuit-info">
          <EditableTitle key={session.id} session={session} onRename={onRename} />
          <div className="transcript-circuit-meta">
            <span>{new Date(session.createdAt).toLocaleString()}</span>
            <span className="meta-separator">&bull;</span>
            <span>{formatDuration(session.duration)}</span>
            <span className="meta-separator">&bull;</span>
            <span>{languageLabel(session.language)}</span>
            <span className="meta-separator">&bull;</span>
            <span className={`status-badge status-${session.status}`}>{session.status}</span>
            {session.status === 'completed' && typeof session.confidenceScore === 'number' && (
              <>
                <span className="meta-separator">&bull;</span>
                <ConfidenceBadge score={session.confidenceScore} withLabel />
              </>
            )}
          </div>
          {session.trackWarning && (
            <div className="transcript-track-warning" role="status">{session.trackWarning}</div>
          )}
          {session.status === 'completed' && audioDeleted && (
            <div className="transcript-audio-deleted" role="status">
              Audio deleted — transcript only.
              {session.sourceUrl && onRedownload && (
                <>
                  {' '}
                  <button type="button" className="transcript-audio-deleted-link" onClick={handleRedownload} disabled={redownloading}>
                    {redownloading ? 'Starting...' : 'Re-download'}
                  </button>
                </>
              )}
            </div>
          )}
          {session.status === 'completed' && !audioDeleted && session.wavAutoDeletedAt && (
            <div className="transcript-audio-deleted" role="status">
              WAV removed after transcription{typeof session.confidenceScore === 'number' ? ` (${session.confidenceScore}%)` : ''}. Re-transcribing rebuilds it from the original file.
            </div>
          )}
        </div>

        {(session.status === 'completed' || session.status === 'failed') && (
          <div className="transcript-circuit-diagram">
            <svg className="transcript-circuit-svg" viewBox="0 0 340 110" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              {session.status === 'completed' && (
                <>
                  <line x1="170" y1="28" x2="85" y2="82" className="transcript-circuit-line" />
                  <line x1="170" y1="28" x2="170" y2="82" className="transcript-circuit-line" />
                </>
              )}
              {onRetranscribe && (
                <line x1="170" y1="28" x2="255" y2="82" className="transcript-circuit-line" />
              )}
            </svg>

            <div className="transcript-info-node">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </div>

            {session.status === 'completed' && (
              <div className="transcript-action-wrap transcript-action-wrap--copy">
                <button type="button" className="transcript-action-node" onClick={handleCopyWithTimestamps} aria-label="Copy transcript">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span className="transcript-action-label">{feedbackText || 'Copy'}</span>
                </button>
              </div>
            )}

            {session.status === 'completed' && (
              <div className="transcript-action-wrap transcript-action-wrap--export" ref={dropdownRef}>
                <button type="button" className="transcript-action-node" onClick={() => setDropdownOpen(prev => !prev)} aria-label="Export options">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span className="transcript-action-label">Export</span>
                </button>
                {dropdownOpen && (
                  <div className="export-menu">
                    <button type="button" className="export-menu-item export-menu-item--1" onClick={handleCopyWithTimestamps}>Copy with timestamps</button>
                    <button type="button" className="export-menu-item export-menu-item--2" onClick={handleCopyTextOnly}>Copy text only</button>
                    <div className="export-menu-divider" />
                    <button type="button" className="export-menu-item export-menu-item--3" onClick={handleDownloadTxt}>Download .txt</button>
                    <button type="button" className="export-menu-item export-menu-item--4" onClick={handleDownloadSrt}>Download .srt</button>
                    {hasAcceptedCorrection && (
                      <button type="button" className="export-menu-item export-menu-item--4" onClick={handleDownloadCorrectedTxt}>Download corrected .txt</button>
                    )}
                    <div className="export-menu-divider" />
                    <button type="button" className="export-menu-item export-menu-item--5 export-menu-item--praxis" onClick={handleSendToPraxis}>Send to Praxis</button>
                  </div>
                )}
              </div>
            )}

            {onRetranscribe && (
              <div className="transcript-action-wrap transcript-action-wrap--retranscribe" ref={retranscribeRef}>
                <button type="button" className="transcript-action-node" onClick={() => { if (!audioDeleted) setRetranscribeOpen(prev => !prev); }} disabled={retrying || audioDeleted} title={audioDeleted ? 'Audio was deleted in Archive' : undefined} aria-label="Re-transcribe">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                  <span className="transcript-action-label">{audioDeleted ? 'No audio' : retrying ? '...' : 'Redo'}</span>
                </button>
                {retranscribeOpen && (
                  <div className="retranscribe-menu">
                    <label
                      className={`retranscribe-boost-toggle${!ffmpegAvailable ? ' retranscribe-boost-toggle--disabled' : ''}`}
                      title={!ffmpegAvailable ? 'Requires ffmpeg' : 'Amplify quiet audio before transcription'}
                    >
                      <input
                        type="checkbox"
                        checked={boostEnabled}
                        onChange={(e) => setBoostEnabled(e.target.checked)}
                        disabled={!ffmpegAvailable}
                      />
                      <span>Boost audio</span>
                    </label>
                    <div className="retranscribe-menu-divider" />
                    <button type="button" className="retranscribe-menu-item retranscribe-menu-item--1" onClick={() => handleRetranscribe('ru')}>Russian</button>
                    <button type="button" className="retranscribe-menu-item retranscribe-menu-item--2" onClick={() => handleRetranscribe('en')}>English</button>
                    <button type="button" className="retranscribe-menu-item retranscribe-menu-item--3" onClick={() => handleRetranscribe('auto')}>Auto-detect</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="transcript-body">
        {(actionItems !== null || session.status === 'completed') && (
          <div className="transcript-action-items">
            <ActionItemsPanel
              variant="session"
              items={actionItems?.items ?? []}
              participants={actionItems?.participants ?? { me: session.participants?.me ?? '', them: session.participants?.them ?? '' }}
              onAdd={handleActionAdd}
              onEdit={handleActionEdit}
              onDelete={handleActionDelete}
              source={sourceNav}
              onSendToPraxis={(ids, mode) => setPraxisExport({ ids, mode })}
            />
          </div>
        )}
        {session.status === 'uploading' && (
          <div className="transcript-status-panel">
            {session.sourceUrl ? (
              <>
                <div className="transcription-progress-wrapper">
                  <div className="transcription-progress-bar">
                    <div
                      className="transcription-progress-fill transcription-progress-fill--download"
                      style={session.downloadProgress != null && session.downloadProgress > 0
                        ? { width: `${session.downloadProgress}%`, animation: 'none' }
                        : undefined}
                    />
                  </div>
                  <p className="transcription-status-text">
                    Downloading{session.downloadProgress != null && session.downloadProgress > 0
                      ? ` ${session.downloadProgress}%`
                      : '...'}
                  </p>
                </div>
                <div className="transcription-controls">
                  {onCancel && (
                    <button
                      type="button"
                      className="transcription-cancel-btn"
                      onClick={handleCancel}
                      disabled={cancelling}
                    >
                      {cancelling ? 'Cancelling...' : 'Cancel'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="spinner" />
                <p>Uploading audio...</p>
              </>
            )}
          </div>
        )}
        {session.status === 'preparing' && (
          <div className="transcript-status-panel">
            <div className="transcription-progress-wrapper">
              <div className="transcription-progress-bar">
                <div className="transcription-progress-fill" />
              </div>
              <p className="transcription-status-text">Preparing audio...</p>
            </div>
            <div className="transcription-controls">
              {onCancel && (
                <button
                  type="button"
                  className="transcription-cancel-btn"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? 'Cancelling...' : 'Cancel'}
                </button>
              )}
            </div>
          </div>
        )}

        {session.status === 'transcribing' && (
          <div className="transcript-status-panel">
            <ChronoRing session={session} />
            <div className="transcription-controls">
              {onCancel && (
                <button
                  type="button"
                  className="transcription-cancel-btn"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? 'Cancelling...' : 'Cancel'}
                </button>
              )}
              {onRetranscribe && (
                <div className="transcription-restart-wrap" ref={retranscribeRef}>
                  <button
                    type="button"
                    className="transcription-restart-btn"
                    onClick={() => setRetranscribeOpen(prev => !prev)}
                    disabled={retrying}
                  >
                    {retrying ? 'Restarting...' : 'Restart'}
                  </button>
                  {retranscribeOpen && (
                    <div className="retranscribe-menu retranscribe-menu--above">
                      <label
                        className={`retranscribe-boost-toggle${!ffmpegAvailable ? ' retranscribe-boost-toggle--disabled' : ''}`}
                        title={!ffmpegAvailable ? 'Requires ffmpeg' : 'Amplify quiet audio before transcription'}
                      >
                        <input
                          type="checkbox"
                          checked={boostEnabled}
                          onChange={(e) => setBoostEnabled(e.target.checked)}
                          disabled={!ffmpegAvailable}
                        />
                        <span>Boost audio</span>
                      </label>
                      <div className="retranscribe-menu-divider" />
                      <button type="button" className="retranscribe-menu-item retranscribe-menu-item--1" onClick={() => handleRetranscribe('ru')}>Russian</button>
                      <button type="button" className="retranscribe-menu-item retranscribe-menu-item--2" onClick={() => handleRetranscribe('en')}>English</button>
                      <button type="button" className="retranscribe-menu-item retranscribe-menu-item--3" onClick={() => handleRetranscribe('auto')}>Auto-detect</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {session.status === 'failed' && (
          <div className="transcript-status-panel error">
            <p className="error-title">Transcription failed</p>
            <p className="error-message">{session.error || 'An unknown error occurred.'}</p>
            {onRetranscribe && (
              <div className="failed-recovery" ref={failedMenuRef}>
                {audioDeleted || session.error?.includes('Audio file no longer exists') ? (
                  session.sourceUrl && onRedownload ? (
                    <>
                      <p className="failed-no-audio">Audio was deleted. It can be downloaded again from the original link.</p>
                      <button type="button" className="retry-button" onClick={handleRedownload} disabled={redownloading}>
                        {redownloading ? 'Starting...' : 'Re-download audio'}
                      </button>
                    </>
                  ) : audioDeleted ? (
                    <p className="failed-no-audio">Audio was deleted — this session cannot be transcribed again.</p>
                  ) : (
                    <p className="failed-no-audio">Audio file no longer exists — this session cannot be re-transcribed.</p>
                  )
                ) : (
                  <>
                    <button
                      type="button"
                      className="retry-button"
                      onClick={() => setFailedMenuOpen(prev => !prev)}
                      disabled={retrying}
                    >
                      {retrying ? 'Starting...' : 'Transcribe again'}
                    </button>
                    {failedMenuOpen && (
                      <div className="retranscribe-menu retranscribe-menu--above">
                        <label
                          className={`retranscribe-boost-toggle${!ffmpegAvailable ? ' retranscribe-boost-toggle--disabled' : ''}`}
                          title={!ffmpegAvailable ? 'Requires ffmpeg' : 'Amplify quiet audio before transcription'}
                        >
                          <input
                            type="checkbox"
                            checked={boostEnabled}
                            onChange={(e) => setBoostEnabled(e.target.checked)}
                            disabled={!ffmpegAvailable}
                          />
                          <span>Boost audio</span>
                        </label>
                        <div className="retranscribe-menu-divider" />
                        <button type="button" className="retranscribe-menu-item retranscribe-menu-item--1" onClick={() => handleFailedRetranscribe('ru')}>Russian</button>
                        <button type="button" className="retranscribe-menu-item retranscribe-menu-item--2" onClick={() => handleFailedRetranscribe('en')}>English</button>
                        <button type="button" className="retranscribe-menu-item retranscribe-menu-item--3" onClick={() => handleFailedRetranscribe('auto')}>Auto-detect</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {session.status === 'completed' && (
          <div className="transcript-lines" ref={linesRef}>
            {pendingCount > 0 && (
              <div className="corrections-bar" role="status">
                <span className="corrections-bar-text">{pendingCount === 1 ? '1 suggested fix' : `${pendingCount} suggested fixes`}</span>
                <button type="button" className="correction-btn correction-btn--accept" disabled={correctionBusy !== null} onClick={handleAcceptAll}>Accept all</button>
              </div>
            )}
            {parsedLines.length === 0 && (
              <p className="transcript-empty">No speech was detected in this recording.</p>
            )}
            {parsedLines.map((line, index) => {
              // AUG-181: mic-muted divider (no timestamp, no corrections)
              if (!line.timestamp && /^— mic muted .*—$/.test(line.text)) {
                return <div key={index} className="transcript-line transcript-line--gap">{line.text}</div>;
              }
              // A fix targets one flagged segment inside the line (single-track lines merge many segments).
              const lineItems = (utteranceIndexByLine[index] >= 0 ? correctionsByIndex.get(utteranceIndexByLine[index]) : undefined)
                ?.filter((c) => line.text.includes(c.original)) ?? [];
              const shownText = applyItemsToText(line.text, lineItems);
              const lineRow = (
                <div className="transcript-line">
                  {line.timestamp && <span className="transcript-timestamp">{line.timestamp}</span>}
                  {line.role && <span className={`transcript-role transcript-role-${line.role.toLowerCase()}`}>{line.role}</span>}
                  <span className="transcript-text">{shownText}</span>
                </div>
              );
              return (
                <React.Fragment key={index}>
                  {index === sourceIndex ? (
                    <div
                      className="transcript-line--source source-line"
                      role="button"
                      tabIndex={0}
                      title="Back to the action item"
                      onClick={handleSourceBack}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSourceBack(); } }}
                    >
                      <div className="source-line-tag-row"><span className="source-line-tag">Source of action item</span></div>
                      {lineRow}
                    </div>
                  ) : lineRow}
                  {lineItems.map((item) => {
                    const busy = correctionBusy === item.id || correctionBusy === -1;
                    if (item.status !== 'pending') {
                      return (
                        <div className="correction-state" key={item.id}>
                          {item.status === 'accepted' ? 'Fix accepted' : 'Fix rejected'} &middot;{' '}
                          <button type="button" className="correction-undo" disabled={busy} onClick={() => handleCorrection(item, 'pending')}>Undo</button>
                        </div>
                      );
                    }
                    const diff = diffWords(item.original, item.suggested);
                    return (
                      <div className="correction-card" key={item.id}>
                        <div className="correction-diff">
                          <span className="correction-label">Was</span>
                          <span className="correction-old">{renderDiffParts(diff.oldParts, 'del')}</span>
                          <span className="correction-label">Now</span>
                          <span className="correction-new">{renderDiffParts(diff.newParts, 'ins')}</span>
                        </div>
                        <div className="correction-actions">
                          <button type="button" className="correction-btn correction-btn--accept" disabled={busy} onClick={() => handleCorrection(item, 'accepted')}>Accept</button>
                          <button type="button" className="correction-btn" disabled={busy} onClick={() => handleCorrection(item, 'rejected')}>Reject</button>
                        </div>
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        )}

        {audio.playback && (
          <div className="transcript-player" role="group" aria-label="Audio player">
            <button type="button" className="action-item-chip" onClick={audio.stop}>■ Stop</button>
            <span className="transcript-player-time">
              {formatClock(audio.playback.currentSec * 1000)} / {audio.playback.durationSec !== null ? formatClock(audio.playback.durationSec * 1000) : '--:--:--'}
            </span>
            <span className="transcript-player-note" role="status">{audio.playback.failed ? 'This audio cannot be played.' : 'Playing from the action item'}</span>
            <div className="transcript-player-bar" aria-hidden="true">
              <i style={{ width: `${audio.playback.durationSec ? Math.min(100, (audio.playback.currentSec / audio.playback.durationSec) * 100).toFixed(2) : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      {showNamePopup && onRename && (
        <NamePopup
          key={session.id}
          session={session}
          onRename={onRename}
          onClose={() => { closedNamePopups.add(session.id); bumpNamePopup((n) => n + 1); }}
        />
      )}

      {showPraxisModal && (
        <PraxisModal
          sessionId={session.id}
          sessionTitle={session.title}
          projects={praxisProjects ?? []}
          defaultPromptCustom={praxisDefaultPromptCustom}
          recentPaths={praxisRecentPaths ?? []}
          onPreferenceChange={onPraxisPreferenceChange}
          onRenameSession={onRename}
          onClose={() => setShowPraxisModal(false)}
        />
      )}
      {praxisExport && (
        <PraxisModal
          sessionId={session.id}
          sessionTitle={session.title}
          projects={praxisProjects ?? []}
          defaultPromptCustom={praxisDefaultPromptCustom}
          recentPaths={praxisRecentPaths ?? []}
          onPreferenceChange={onPraxisPreferenceChange}
          onClose={() => setPraxisExport(null)}
          actionItems={{
            mode: praxisExport.mode,
            count: praxisExport.ids.length,
            alreadySent: (actionItems?.items ?? [])
              .filter((i) => praxisExport.ids.includes(i.id) && i.praxis)
              .map((i) => i.praxis!.taskId),
            onSubmit: async (projectPath, force) => {
              const r = await sendActionItemsToPraxis({ projectPath, mode: praxisExport.mode, itemIds: praxisExport.ids, sessionId: session.id, force });
              setActionItems(r.file);
              return { taskIds: r.tasks.map((t) => t.taskId) };
            },
          }}
        />
      )}
    </div>
  );
};

export default TranscriptView;
