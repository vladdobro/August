import React, { useState, useEffect, useRef } from 'react';
import { sendToPraxis, validatePraxisProject, browsePraxisFolder } from '../api';
import type { PraxisProject, UserPreferences } from '../services/preferences';
import SettingsDropdown from './SettingsDropdown';

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
  projects: PraxisProject[];
  defaultPromptCustom?: boolean;
  onClose: () => void;
  onRenameSession?: (title: string) => Promise<void>;
  /// AUG-192: recent unregistered folders (server pref praxisRecentPaths) and the preferences writer.
  recentPaths?: string[];
  onPreferenceChange?: (patch: Partial<UserPreferences>) => void | Promise<void>;
  /// AUG-166: export of action items instead of the transcript card.
  actionItems?: {
    mode: 'separate' | 'common';
    count: number;
    alreadySent: string[]; // task ids of selected items already sent
    onSubmit: (projectPath: string, force: boolean) => Promise<{ taskIds: string[] }>;
  };
}

const OTHER = '__other__';
const CHIP_LIMIT = 5;
const RECENT_LIMIT = 5;

const shortPath = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

const shortenPath = (p: string): string => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  const sep = p.includes('\\') ? '\\' : '/';
  return parts.length <= 3 ? p : `${parts[0]}${sep}…${sep}${parts.slice(-2).join(sep)}`;
};

const samePath = (a: string, b: string): boolean =>
  a.trim().replace(/[\\/]+$/, '').toLowerCase() === b.trim().replace(/[\\/]+$/, '').toLowerCase();

const PraxisModal: React.FC<PraxisModalProps> = ({ sessionId, sessionTitle, projects, defaultPromptCustom, onClose, onRenameSession, recentPaths = [], onPreferenceChange, actionItems }) => {
  const [projectPath, setProjectPath] = useState('');
  const [selected, setSelected] = useState<string>(OTHER);
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const [taskName, setTaskName] = useState(sessionTitle);
  const [browsing, setBrowsing] = useState(false);
  const [sending, setSending] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ taskId: string; projectTag: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = (recentPaths[0] ?? '').trim();
    const match = saved ? projects.find((p) => samePath(p.path, saved)) : undefined;
    const defaultProject = projects.find((p) => p.isDefault);
    if (match) {
      setSelected(match.path);
    } else if (saved) {
      setSelected(OTHER);
      setProjectPath(saved);
    } else if (defaultProject) {
      setSelected(defaultProject.path);
    } else if (projects[0]) {
      setSelected(projects[0].path);
    } else {
      setSelected(OTHER);
      setProjectPath('');
    }
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recents = recentPaths.filter((r) => !projects.some((p) => samePath(p.path, r)));

  const rememberRecent = (sent: string) => {
    if (!onPreferenceChange) return;
    if (projects.some((p) => samePath(p.path, sent))) return;
    const next = [sent, ...recentPaths.filter((r) => !samePath(r, sent))].slice(0, RECENT_LIMIT);
    void Promise.resolve(onPreferenceChange({ praxisRecentPaths: next })).catch(() => {});
  };
  const removeRecent = (p: string) => {
    if (selected === OTHER && samePath(projectPath, p)) setProjectPath('');
    void Promise.resolve(onPreferenceChange?.({ praxisRecentPaths: recentPaths.filter((r) => !samePath(r, p)) })).catch(() => {});
  };
  const saveRecent = (p: string) => {
    const project: PraxisProject = { path: p, name: shortPath(p), isDefault: projects.length === 0 };
    void Promise.resolve(onPreferenceChange?.({
      praxisProjects: [...projects, project],
      praxisRecentPaths: recentPaths.filter((r) => !samePath(r, p)),
    })).catch(() => {});
    setSelected(p);
    setError(null);
  };
  const pickRecent = (p: string) => { setSelected(OTHER); setProjectPath(p); setError(null); };
  const recentOn = (p: string) => selected === OTHER && samePath(projectPath, p);

  const recentChips = recents.length > 0 && (
    <>
      <span className="praxis-chips-divider">Recent</span>
      {recents.map((r) => (
        <div key={r} className="praxis-chip-wrap">
          <button
            type="button"
            role="radio"
            aria-checked={recentOn(r)}
            className={`praxis-chip praxis-chip--recent${recentOn(r) ? ' praxis-chip--on' : ''}`}
            title={r}
            disabled={sending || validating}
            onClick={() => pickRecent(r)}
          >
            <span className="praxis-chip-name">{shortPath(r)}</span>
            <span className="praxis-chip-sub">{shortenPath(r)}</span>
          </button>
          <button type="button" className="praxis-chip-x" aria-label={`Remove ${shortPath(r)} from recent`} title="Remove from recent" disabled={sending || validating} onClick={() => removeRecent(r)}>×</button>
          <button type="button" className="praxis-chip-save" aria-label={`Save ${shortPath(r)} to Projects`} title="Save to Projects" disabled={sending || validating} onClick={() => saveRecent(r)}>Save</button>
        </div>
      ))}
    </>
  );

  const useChips = projects.length > 0 && projects.length <= CHIP_LIMIT;
  const sel = projects.find((p) => p.path === selected);
  const defaultLabel = `default · ${defaultPromptCustom ? 'custom' : 'built-in'}`;
  const promptHint = selected === OTHER && recents.some(recentOn) ? 'Recent · last 5 sent, oldest drops off' : sel?.prompt ? `Prompt: ${sel.name} · custom` : `Prompt: ${defaultLabel}`;

  const options = [
    ...projects.map((p) => ({ value: p.path, label: p.name + (p.isDefault ? '  ·  default' : ''), sublabel: p.path })),
    { value: OTHER, label: 'Other…', sublabel: 'Enter a path manually' },
  ];

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await browsePraxisFolder();
      if (result.path) {
        setProjectPath(result.path);
        setSelected(OTHER);
      }
    } catch {
      // dialog cancelled or error
    } finally {
      setBrowsing(false);
    }
  };

  const handleSend = async () => {
    const trimmed = selected === OTHER ? projectPath.trim() : selected;
    if (!trimmed) {
      setError('Please choose a project or enter a path');
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
      if (actionItems) {
        const out = await actionItems.onSubmit(trimmed, actionItems.alreadySent.length > 0);
        rememberRecent(trimmed);
        setSuccess({ taskId: out.taskIds.join(', '), projectTag: null });
        return;
      }
      const result = await sendToPraxis(sessionId, trimmed, taskName.trim() || undefined);
      rememberRecent(trimmed);
      const nextTitle = taskName.trim();
      if (onRenameSession && nextTitle && nextTitle !== sessionTitle) {
        try {
          await onRenameSession(nextTitle);
        } catch {
          setRenameNote('Task created, but the session could not be renamed.');
        }
      }
      setSuccess({ taskId: result.taskId, projectTag: result.projectTag });
    } catch (err) {
      setError((err as Error).message || 'Failed to create task');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).closest('.settings-dropdown')) return;
    if (e.key === 'Enter' && (e.target as HTMLElement).closest('.praxis-chips')) return;
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
          <h3 className="praxis-modal-title">{actionItems ? 'Action items → Praxis' : 'Send to Praxis'}</h3>
          <button type="button" className="praxis-modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {!success ? (
          <>
            {!actionItems && <label className="praxis-label">
              Task name
              <input
                ref={inputRef}
                type="text"
                className="praxis-input"
                value={taskName}
                onChange={(e) => setTaskName(e.target.value)}
                placeholder="Process meeting: My Session"
                disabled={sending || validating}
              />
              {onRenameSession && <span className="praxis-field-note">Also becomes the session name</span>}
            </label>}

            <label className="praxis-label">
              Project
              {useChips ? (
                <div className="praxis-chips" role="radiogroup" aria-label="Project">
                  {projects.map((p) => (
                    <button
                      key={p.path}
                      type="button"
                      role="radio"
                      aria-checked={selected === p.path}
                      className={`praxis-chip${selected === p.path ? ' praxis-chip--on' : ''}`}
                      title={p.path}
                      disabled={sending || validating}
                      onClick={() => { setSelected(p.path); setError(null); }}
                    >
                      <span className="praxis-chip-name">{p.name}</span>
                      <span className="praxis-chip-sub">{p.isDefault ? 'default' : shortPath(p.path)}</span>
                    </button>
                  ))}
                  {recentChips}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected === OTHER && !recents.some(recentOn)}
                    className={`praxis-chip${selected === OTHER && !recents.some(recentOn) ? ' praxis-chip--on' : ''}`}
                    onClick={() => { if (recents.some(recentOn)) setProjectPath(''); setSelected(OTHER); }}
                    disabled={sending || validating}
                  >
                    <span className="praxis-chip-name">Other…</span>
                    <span className="praxis-chip-sub">any folder</span>
                  </button>
                </div>
              ) : (
                <SettingsDropdown
                  className="praxis-project-select"
                  value={selected}
                  options={options}
                  onChange={setSelected}
                  placeholder="Choose a project"
                />
              )}
              {!useChips && recents.length > 0 && (
                <div className="praxis-chips" role="radiogroup" aria-label="Recent folders">{recentChips}</div>
              )}
            </label>
            <label className="praxis-label">
              Project path
              <div className="praxis-input-row">
                <input
                  type="text"
                  className="praxis-input"
                  value={selected === OTHER ? projectPath : selected}
                  onChange={(e) => { setProjectPath(e.target.value); setSelected(OTHER); }}
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
              <span className="praxis-field-note">{promptHint}</span>
            </label>

            {actionItems && (
              <span className="praxis-field-note">
                {actionItems.mode === 'separate'
                  ? `${actionItems.count} separate task${actionItems.count === 1 ? '' : 's'}, one per item`
                  : `One task with a ${actionItems.count}-item checklist`}
              </span>
            )}
            {actionItems && actionItems.alreadySent.length > 0 && (
              <p className="praxis-warning">Already sent: {actionItems.alreadySent.join(', ')}. Sending again creates new tasks.</p>
            )}
            {error && <p className="praxis-error">{error}</p>}

            <div className="praxis-actions">
              <button type="button" className="praxis-btn praxis-btn--cancel" onClick={onClose} disabled={sending || validating}>
                Cancel
              </button>
              <button type="button" className="praxis-btn praxis-btn--send" onClick={handleSend} disabled={sending || validating}>
                {validating ? 'Validating...' : sending ? 'Creating...' : actionItems ? (actionItems.alreadySent.length > 0 ? 'Send again' : actionItems.mode === 'separate' ? `Create ${actionItems.count} task${actionItems.count === 1 ? '' : 's'}` : 'Create task') : 'Create Task'}
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
              <p>{actionItems && actionItems.mode === 'separate' && actionItems.count > 1 ? 'Tasks created' : 'Task created successfully'}</p>
              <span className="praxis-task-id">{success.taskId}</span>
              {renameNote && <p className="praxis-error">{renameNote}</p>}
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
