import React, { useEffect, useRef, useState } from 'react';
import type { PraxisProject, UserPreferences } from '../services/preferences';
import { browsePraxisFolder, fetchPraxisDefaultPrompt, validatePraxisProject } from '../api';

interface PraxisProjectsPageProps {
  preferences: UserPreferences;
  onPreferenceChange: (patch: Partial<UserPreferences>) => void;
}

type Selection = { kind: 'default' } | { kind: 'new' } | { kind: 'project'; path: string };

const VARIABLES = ['{sessionName}', '{date}', '{duration}'];

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const normKey = (p: string): string => p.trim().replace(/[\\/]+$/, '').toLowerCase();

const PraxisProjectsPage: React.FC<PraxisProjectsPageProps> = ({ preferences, onPreferenceChange }) => {
  const projects = preferences.praxisProjects ?? [];
  const storedDefault = preferences.praxisDefaultPrompt ?? null;
  const save = (next: PraxisProject[]) => onPreferenceChange({ praxisProjects: next });

  const [selection, setSelection] = useState<Selection>(() => {
    const def = (preferences.praxisProjects ?? []).find((p) => p.isDefault);
    return def ? { kind: 'project', path: def.path } : { kind: 'default' };
  });
  const [prevSelection, setPrevSelection] = useState<Selection | null>(null);
  const [builtIn, setBuiltIn] = useState<string | null>(null);
  const [defaultDraft, setDefaultDraft] = useState('');
  const [defaultDirty, setDefaultDirty] = useState(false);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [reachability, setReachability] = useState<Record<string, boolean>>({});
  const [checkingPath, setCheckingPath] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPath, setAddPath] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const project = selection.kind === 'project'
    ? projects.find((p) => p.path === selection.path) ?? null
    : null;

  const flashSaved = () => {
    setSaved(true);
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1500);
  };

  useEffect(() => () => {
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
  }, []);

  const selectionKey = selection.kind + (selection.kind === 'project' ? selection.path : '');
  useEffect(() => {
    setNameDraft(null);
    setPathDraft(null);
    setPromptDraft(null);
    setPathError(null);
  }, [selectionKey]);

  useEffect(() => {
    if (selection.kind === 'project' && !projects.some((p) => p.path === selection.path)) {
      setSelection({ kind: 'default' });
    }
  }, [selection, projects]);

  useEffect(() => {
    let cancelled = false;
    fetchPraxisDefaultPrompt()
      .then((r) => { if (!cancelled) setBuiltIn(r.prompt); })
      .catch(() => { if (!cancelled) setBuiltIn(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (defaultDirty) return;
    setDefaultDraft(storedDefault ?? builtIn ?? '');
  }, [builtIn, storedDefault, defaultDirty]);

  const projectPathsKey = projects.map((p) => p.path).join('\n');
  useEffect(() => {
    let cancelled = false;
    const paths = projectPathsKey ? projectPathsKey.split('\n') : [];
    paths.forEach((p) => {
      validatePraxisProject(p)
        .then((r) => { if (!cancelled) setReachability((prev) => ({ ...prev, [p]: r.valid })); })
        .catch(() => { if (!cancelled) setReachability((prev) => ({ ...prev, [p]: false })); });
    });
    return () => { cancelled = true; };
  }, [projectPathsKey]);

  const commitDefault = () => {
    const next = defaultDraft.trim() === (builtIn ?? '').trim() ? null : defaultDraft;
    if (next !== storedDefault) {
      onPreferenceChange({ praxisDefaultPrompt: next });
      flashSaved();
    }
    setDefaultDirty(false);
  };

  const resetDefault = () => {
    onPreferenceChange({ praxisDefaultPrompt: null });
    flashSaved();
    setDefaultDraft(builtIn ?? '');
    setDefaultDirty(false);
  };

  const setDefaultProject = (p: PraxisProject) => {
    save(projects.map((x) => ({ ...x, isDefault: x.path === p.path })));
    flashSaved();
  };

  const removeProject = (p: PraxisProject) => {
    const rest = projects.filter((x) => x.path !== p.path);
    const next = p.isDefault && rest.length > 0 ? rest.map((x, i) => ({ ...x, isDefault: i === 0 })) : rest;
    save(next);
    flashSaved();
    const newDefault = next.find((x) => x.isDefault);
    setSelection(newDefault ? { kind: 'project', path: newDefault.path } : { kind: 'default' });
  };

  const withoutPrompt = (x: PraxisProject): PraxisProject => {
    const { prompt: _dropped, ...rest } = x;
    return rest;
  };

  const commitPrompt = (p: PraxisProject) => {
    if (promptDraft === null) return;
    if (promptDraft.trim() === '') {
      if (p.prompt) {
        save(projects.map((x) => (x.path === p.path ? withoutPrompt(x) : x)));
        flashSaved();
      }
    } else if (promptDraft !== p.prompt) {
      save(projects.map((x) => (x.path === p.path ? { ...x, prompt: promptDraft } : x)));
      flashSaved();
    }
    setPromptDraft(null);
  };

  const useDefaultPrompt = (p: PraxisProject) => {
    save(projects.map((x) => (x.path === p.path ? withoutPrompt(x) : x)));
    flashSaved();
    setPromptDraft(null);
  };

  const commitName = (p: PraxisProject) => {
    if (nameDraft === null) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== p.name) {
      save(projects.map((x) => (x.path === p.path ? { ...x, name: trimmed } : x)));
      flashSaved();
    }
    setNameDraft(null);
  };

  const commitPath = async (p: PraxisProject, override?: string) => {
    const next = (override ?? pathDraft ?? p.path).trim();
    if (!next || normKey(next) === normKey(p.path)) {
      setPathDraft(null);
      setPathError(null);
      return;
    }
    if (projects.some((x) => x.path !== p.path && normKey(x.path) === normKey(next))) {
      setPathError('Another project already uses this path');
      return;
    }
    setCheckingPath(true);
    try {
      const v = await validatePraxisProject(next);
      if (projects.some((x) => x.path !== p.path && normKey(x.path) === normKey(v.projectPath))) {
        setPathError('Another project already uses this path');
        return;
      }
      save(projects.map((x) => (x.path === p.path ? { ...x, path: v.projectPath } : x)));
      setReachability((prev) => ({ ...prev, [v.projectPath]: v.valid }));
      setSelection({ kind: 'project', path: v.projectPath });
      setPathDraft(null);
      setPathError(null);
      flashSaved();
    } catch {
      setPathError('Could not check this path');
    } finally {
      setCheckingPath(false);
    }
  };

  const browseIntoPathDraft = async (p: PraxisProject) => {
    setBrowsing(true);
    try {
      const result = await browsePraxisFolder();
      if (result.path) {
        setPathDraft(result.path);
        await commitPath(p, result.path);
      }
    } catch {
      // dialog cancelled or error
    } finally {
      setBrowsing(false);
    }
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await browsePraxisFolder();
      if (result.path) {
        setAddPath(result.path);
        if (!addName.trim()) setAddName(baseName(result.path));
      }
    } catch {
      // dialog cancelled or error
    } finally {
      setBrowsing(false);
    }
  };

  const cancelNew = () => {
    setAddError(null);
    setSelection(prevSelection ?? { kind: 'default' });
  };

  const handleAdd = async () => {
    const trimmed = addPath.trim();
    setAddError(null);
    if (!trimmed) {
      setAddError('Enter a project path');
      return;
    }
    const existing = new Set(projects.map((p) => normKey(p.path)));
    if (existing.has(normKey(trimmed))) {
      setAddError('This project is already registered');
      return;
    }
    setAdding(true);
    try {
      const validation = await validatePraxisProject(trimmed);
      if (existing.has(normKey(validation.projectPath))) {
        setAddError('This project is already registered');
        return;
      }
      if (!validation.valid) {
        setAddError(`No .praxis/ directory found at: ${validation.projectPath}`);
        return;
      }
      save([
        ...projects,
        {
          path: validation.projectPath,
          name: addName.trim() || baseName(validation.projectPath),
          isDefault: projects.length === 0,
        },
      ]);
      flashSaved();
      setAddName('');
      setAddPath('');
      setSelection({ kind: 'project', path: validation.projectPath });
    } catch (err) {
      setAddError((err as Error).message || 'Failed to check the project path');
    } finally {
      setAdding(false);
    }
  };

  const insertVariable = (token: string, value: string, setValue: (v: string) => void) => {
    const el = promptRef.current;
    if (!el) {
      setValue(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const renderChips = (value: string, setValue: (v: string) => void) => (
    <div className="praxis-vars">
      {VARIABLES.map((token) => (
        <button
          key={token}
          type="button"
          className="praxis-var-chip"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => insertVariable(token, value, setValue)}
        >
          {token}
        </button>
      ))}
    </div>
  );

  const handleListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const entries: Selection[] = [
      { kind: 'default' },
      ...projects.map((p) => ({ kind: 'project', path: p.path }) as Selection),
    ];
    let idx = entries.findIndex((en) =>
      en.kind === selection.kind && (en.kind !== 'project' || (selection.kind === 'project' && en.path === selection.path)));
    if (idx < 0) idx = 0;
    const nextIdx = Math.max(0, Math.min(entries.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
    setSelection(entries[nextIdx]);
  };

  const escToList = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.currentTarget.blur();
      listRef.current?.focus();
    }
  };

  const isDefaultSel = selection.kind === 'default';
  const title = selection.kind === 'default'
    ? 'Default prompt'
    : selection.kind === 'new'
      ? 'New project'
      : project?.name ?? '';

  return (
    <div className="praxis-md">
      <div className="praxis-md-side">
        <div
          ref={listRef}
          className="praxis-md-list"
          role="listbox"
          tabIndex={0}
          aria-label="Praxis projects"
          onKeyDown={handleListKey}
        >
          <button
            type="button"
            role="option"
            aria-selected={isDefaultSel}
            tabIndex={-1}
            className={`praxis-md-item praxis-md-item--pinned${isDefaultSel ? ' praxis-md-item--on' : ''}`}
            onClick={() => setSelection({ kind: 'default' })}
          >
            <span className="praxis-md-item-row">
              <span className="praxis-md-item-name">Default settings</span>
              {storedDefault && <span className="praxis-project-badge praxis-project-badge--muted">custom</span>}
            </span>
            <span className="praxis-project-path">prompt for all projects</span>
          </button>
          {projects.map((p) => {
            const sel = selection.kind === 'project' && selection.path === p.path;
            return (
              <button
                key={p.path}
                type="button"
                role="option"
                aria-selected={sel}
                tabIndex={-1}
                className={`praxis-md-item${sel ? ' praxis-md-item--on' : ''}`}
                onClick={() => setSelection({ kind: 'project', path: p.path })}
              >
                <span className="praxis-md-item-row">
                  <span className="praxis-md-item-name">{p.name}</span>
                  {p.isDefault && <span className="praxis-project-badge">Default</span>}
                  {p.prompt && <span className="praxis-project-badge praxis-project-badge--muted">prompt</span>}
                  {reachability[p.path] === false && (
                    <span className="praxis-project-badge praxis-project-badge--missing" title="No .praxis/ directory found at this path">!</span>
                  )}
                </span>
                <span className="praxis-project-path" title={p.path}>{p.path}</span>
              </button>
            );
          })}
          {projects.length === 0 && <div className="settings-hint praxis-md-empty">No projects yet.</div>}
        </div>
        <button
          type="button"
          className={`settings-btn-inline praxis-md-add${selection.kind === 'new' ? ' praxis-md-add--on' : ''}`}
          onClick={() => {
            if (selection.kind !== 'new') setPrevSelection(selection);
            setSelection({ kind: 'new' });
          }}
        >
          + Add project
        </button>
      </div>

      <div className="praxis-md-detail">
        <div className="praxis-md-head">
          <span className="settings-section-title praxis-md-title">{title}</span>
          <span className={`praxis-saved${saved ? ' praxis-saved--on' : ''}`} aria-live="polite">Saved</span>
        </div>

        {selection.kind === 'default' && (
          <>
            <div className="settings-hint">Used for every project without its own prompt.</div>
            {renderChips(defaultDraft, (v) => { setDefaultDraft(v); setDefaultDirty(true); })}
            <textarea
              ref={promptRef}
              className="settings-textarea praxis-md-textarea"
              value={defaultDraft}
              onChange={(e) => { setDefaultDraft(e.target.value); setDefaultDirty(true); }}
              onBlur={commitDefault}
              onKeyDown={escToList}
            />
            <div className="praxis-md-foot">
              <button type="button" className="settings-btn-inline" onClick={resetDefault} disabled={!storedDefault}>
                Reset to built-in
              </button>
              <span className="settings-hint">{storedDefault ? 'Custom' : 'Built-in'}</span>
            </div>
          </>
        )}

        {selection.kind === 'new' && (
          <>
            <div className="praxis-md-field">
              <label>Name (optional)</label>
              <input
                type="text"
                className="settings-input"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={escToList}
              />
            </div>
            <div className="praxis-md-field">
              <label>Path</label>
              <div className="settings-path-group">
                <input
                  type="text"
                  className="settings-input"
                  placeholder="D:\path\to\project or /Users/me/project"
                  value={addPath}
                  onChange={(e) => setAddPath(e.target.value)}
                  onKeyDown={escToList}
                />
                <button type="button" className="settings-btn-inline" onClick={handleBrowse} disabled={browsing || adding}>
                  {browsing ? '...' : 'Browse'}
                </button>
              </div>
            </div>
            {addError && <p className="praxis-error">{addError}</p>}
            <div className="praxis-md-foot">
              <button type="button" className="settings-btn-inline" onClick={cancelNew}>Cancel</button>
              <button type="button" className="settings-btn-inline praxis-btn-inline--primary" onClick={handleAdd} disabled={adding}>
                {adding ? '...' : 'Add project'}
              </button>
            </div>
          </>
        )}

        {selection.kind === 'project' && project && (
          <>
            <div className="praxis-md-field">
              <label>Name</label>
              <input
                type="text"
                className="settings-input"
                value={nameDraft ?? project.name}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => commitName(project)}
                onKeyDown={escToList}
              />
            </div>
            <div className="praxis-md-field">
              <label>Path</label>
              <div className="settings-path-group">
                <input
                  type="text"
                  className="settings-input"
                  value={pathDraft ?? project.path}
                  onChange={(e) => setPathDraft(e.target.value)}
                  onBlur={() => void commitPath(project)}
                  onKeyDown={escToList}
                />
                <button
                  type="button"
                  className="settings-btn-inline"
                  onClick={() => void browseIntoPathDraft(project)}
                  disabled={browsing || checkingPath}
                >
                  {browsing ? '...' : 'Browse'}
                </button>
              </div>
              {pathError && <p className="praxis-error">{pathError}</p>}
            </div>
            <div className="praxis-md-row">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={project.isDefault}
                  disabled={project.isDefault}
                  onChange={() => setDefaultProject(project)}
                />
                <span className="settings-toggle-label">Use as default project</span>
              </label>
              {reachability[project.path] === false
                ? <span className="praxis-project-badge praxis-project-badge--missing">Missing</span>
                : reachability[project.path] === true
                  ? <span className="praxis-project-badge">Reachable</span>
                  : null}
            </div>
            <div className="praxis-md-field praxis-md-field--grow">
              <label>
                Prompt{' '}
                <span className="praxis-md-label-note">
                  {project.prompt
                    ? <>custom · <button type="button" className="praxis-link" onClick={() => useDefaultPrompt(project)}>use default</button></>
                    : 'default'}
                </span>
              </label>
              {renderChips(promptDraft ?? project.prompt ?? '', setPromptDraft)}
              <textarea
                ref={promptRef}
                className="settings-textarea praxis-md-textarea"
                placeholder="Leave empty to use the default prompt"
                value={promptDraft ?? project.prompt ?? ''}
                onChange={(e) => setPromptDraft(e.target.value)}
                onBlur={() => commitPrompt(project)}
                onKeyDown={escToList}
              />
            </div>
            <div className="praxis-md-foot">
              <button type="button" className="settings-btn-inline settings-btn-inline--danger" onClick={() => removeProject(project)}>
                Remove project
              </button>
              <span className="settings-hint">Saves automatically</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PraxisProjectsPage;
