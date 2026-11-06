// AUG-199: ASSISTANT column: project tabs (one Claude Code session per Praxis project), chat, input, Stop session.
// Plain text only (no HTML injection). Never shows money, model names, token counts or tool names.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browsePraxisFolder } from '../../api';
import {
  assistantStore, baseName, deriveView, inputDisabledReason, isBlockedView, praxisIsDown, useAssistantStore,
  type AssistantTab, type ChatEntry, type TaskInfo,
} from '../../services/assistantStore';
import type { PraxisProject } from '../../services/preferences';
import { shortTaskId } from '../ActionItemsPanel';

type ClaudeEntry = Extract<ChatEntry, { kind: 'claude' }>;

const BLOCK_TEXT = {
  off: 'Active session is off. Turn it on in Settings → AI assistants to ask Claude about this project.',
  missing: 'Claude Code is not installed on this computer. Install it, sign in, then press Recheck.',
  'signed-out': 'Claude Code is installed but not signed in. Open a terminal, run claude and sign in with your browser, then press Recheck.',
  'too-old': 'Claude Code is too old for the session. Update it, then press Recheck.',
  unsupported: 'This Claude Code install cannot run the session. Install the native build, then press Recheck.',
} as const;

const WARN_TEXT = {
  praxis: 'PraxisOS is not running. Claude answers without the project notes; hints are paused. It reconnects when PraxisOS starts.',
  budget: 'Spending limit reached for this meeting. Raise it in Settings → AI assistants to keep asking; the conversation is kept.',
  limit: 'Three Claude sessions are already running. Stop a session in another tab to ask here.',
  error: 'The session stopped twice in a row. Ask again to start it fresh.',
} as const;

const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

interface AssistantColumnProps {
  projects: PraxisProject[];
  recentPaths: string[];
  onOpenSettings: (tab?: 'assistants') => void;
}

/// Paragraphs and bullet lists from plain text.
const MessageText: React.FC<{ text: string; streaming: boolean }> = ({ text, streaming }) => {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const caret = streaming ? <span className="ap-caret" aria-hidden="true" /> : null;
  if (blocks.length === 0) return <div className="ap-mt">{caret}</div>;
  return (
    <div className="ap-mt">
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1;
        const lines = b.split('\n');
        const isList = lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
        if (isList) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*([-*•]|\d+[.)])\s+/, '')}{last && j === lines.length - 1 ? caret : null}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{b}{last ? caret : null}</p>;
      })}
    </div>
  );
};

function taskLabel(task: TaskInfo | undefined): { text: string; disabled: boolean } {
  if (!task) return { text: '→ Praxis task', disabled: false };
  if (task.state === 'creating') return { text: 'Creating…', disabled: true };
  if (task.state === 'failed') return { text: 'Task not created', disabled: false };
  const id = task.taskId ? shortTaskId(task.taskId) : 'task';
  return { text: `✓ ${id}${task.direct ? ' (created directly)' : ''}`, disabled: true };
}

const ClaudeMessage: React.FC<{ e: ClaudeEntry }> = ({ e }) => {
  const done = !e.streaming && e.text.trim() !== '';
  const task = taskLabel(e.task);
  return (
    <div className="ap-msg ap-msg--c">
      <div className="ap-ml"><b>CLAUDE</b></div>
      {e.tools.length > 0 && (
        <div className="ap-tools">
          {e.tools.map((c) => (
            <span key={c.index} className={`ap-tchip${c.state === 'running' ? ' ap-tchip--prog' : ''}`}>{c.label}</span>
          ))}
        </div>
      )}
      <MessageText text={e.text} streaming={e.streaming} />
      {done && (
        <div className="ap-macts">
          {e.actionState === 'added' ? (
            <button type="button" className="ap-btn" disabled>{'✓ Added'}</button>
          ) : e.actionState === 'duplicate' ? (
            <button type="button" className="ap-btn" disabled>Already in the list</button>
          ) : (
            <button type="button" className="ap-btn ap-btn--go" onClick={() => assistantStore.toAction(e.askId)}>{'→ Action item'}</button>
          )}
          <button type="button" className="ap-btn" disabled={task.disabled} onClick={() => assistantStore.toTask(e.askId)}>{task.text}</button>
          <button type="button" className="ap-btn ap-btn--plain" onClick={() => assistantStore.copy(e.askId)}>Copy</button>
        </div>
      )}
    </div>
  );
};

const Picker: React.FC<{
  tabs: AssistantTab[];
  projects: PraxisProject[];
  recentPaths: string[];
  inline?: boolean;
  onPicked: () => void;
}> = ({ tabs, projects, recentPaths, inline, onPicked }) => {
  const open = new Set(tabs.map((t) => norm(t.projectPath)));
  const sorted = [...projects].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const listed = new Set(projects.map((p) => norm(p.path)));
  const recent = recentPaths.filter((p) => !listed.has(norm(p)));
  const pick = (path: string, name: string) => { assistantStore.openTab(path, name); onPicked(); };
  const browse = async () => {
    try {
      const r = await browsePraxisFolder();
      if (r.path) pick(r.path, baseName(r.path));
    } catch {
      // folder dialog failed: nothing to open
    }
  };
  return (
    <div className={`ap-picker${inline ? ' ap-picker--inline' : ''}`}>
      <div className="ap-pgrp">Projects</div>
      {sorted.length === 0 && <div className="ap-phint">No projects yet. Add them in Settings, or open a folder.</div>}
      {sorted.map((p) => (
        <button key={p.path} type="button" className="ap-prow" disabled={open.has(norm(p.path))} onClick={() => pick(p.path, p.name)}>
          <b>{p.name}</b>
          {p.isDefault && <span className="ap-tag">DEFAULT</span>}
          {open.has(norm(p.path)) && <span className="ap-op">open</span>}
        </button>
      ))}
      {recent.length > 0 && <div className="ap-pgrp">Recent</div>}
      {recent.map((p) => (
        <button key={p} type="button" className="ap-prow" disabled={open.has(norm(p))} onClick={() => pick(p, baseName(p))}>
          <b>{baseName(p)}</b>
          <span className="ap-pth">{p}</span>
          {open.has(norm(p)) && <span className="ap-op">open</span>}
        </button>
      ))}
      <div className="ap-acts"><button type="button" className="ap-btn" onClick={browse}>Open&hellip;</button></div>
      <div className="ap-phint">Picking a project starts hints for it at once; Claude starts on your first question.</div>
    </div>
  );
};

const AssistantColumn: React.FC<AssistantColumnProps> = ({ projects, recentPaths, onOpenSettings }) => {
  const st = useAssistantStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const tabRowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tab = st.tabs.find((t) => t.projectPath === st.active) ?? null;
  const view = deriveView(st);
  const blocked = isBlockedView(view);
  const disabledReason = inputDisabledReason(st);
  const streaming = tab?.streamingAskId != null;
  const contentSize = tab ? tab.chat.reduce((n, e) => n + (e.kind === 'claude' ? e.text.length + e.tools.length : 1), 0) : 0;

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [contentSize, tab?.projectPath]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tabRowRef.current && !tabRowRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // AUG-197: "Ask" on a hint card prefills the question and focuses the input.
  const prefillNonce = st.assistPrefill?.nonce;
  useEffect(() => {
    if (!st.assistPrefill) return;
    setDraft(st.assistPrefill.text);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [prefillNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = () => {
    if (disabledReason || streaming || !draft.trim()) return;
    assistantStore.ask(draft);
    setDraft('');
    stickRef.current = true;
  };

  const renderBody = () => {
    if (view === 'none') {
      return (
        <>
          <div className="ap-pickt">Pick a Praxis project for this meeting</div>
          <Picker tabs={st.tabs} projects={projects} recentPaths={recentPaths} inline onPicked={() => setPickerOpen(false)} />
        </>
      );
    }
    if (view === 'off' || view === 'missing' || view === 'signed-out' || view === 'too-old' || view === 'unsupported') {
      return (
        <div className="ap-empty">
          {BLOCK_TEXT[view]}
          <div className="ap-acts ap-acts--center">
            {view !== 'off' && <button type="button" className="ap-btn ap-btn--go" onClick={() => { void assistantStore.refreshStatus(true); }}>Recheck</button>}
            <button type="button" className="ap-btn" onClick={() => onOpenSettings('assistants')}>Open Settings</button>
          </div>
        </div>
      );
    }
    const chat = tab?.chat ?? [];
    return (
      <>
        {praxisIsDown(st) && <div className="ap-warn">{WARN_TEXT.praxis}</div>}
        {view === 'budget' && <div className="ap-warn">{WARN_TEXT.budget}</div>}
        {view === 'limit' && <div className="ap-warn">{WARN_TEXT.limit}</div>}
        {view === 'error' && <div className="ap-warn">{WARN_TEXT.error}</div>}
        <div>
          <div className="ap-blk-t">Session</div>
          {chat.length === 0 ? (
            <div className="ap-empty">Ask a question about {tab?.name}. Claude starts on your first question.</div>
          ) : (
            <div className="ap-stack">
              {chat.map((e, i) => {
                if (e.kind === 'system') return <div key={i} className="ap-sysl">{e.text}</div>;
                if (e.kind === 'noanswer') {
                  return (
                    <div key={i} className="ap-noans">
                      <span>No answer &mdash; the session stopped while answering.</span>
                      <button type="button" className="ap-btn" onClick={() => assistantStore.askAgain(e.askId)}>Ask again</button>
                    </div>
                  );
                }
                if (e.kind === 'user') {
                  return (
                    <div key={i} className="ap-msg ap-msg--u">
                      <div className="ap-ml"><b>YOU</b></div>
                      <div className="ap-mt"><p>{e.text}</p></div>
                      {e.transcript !== false && <div className="ap-sent">+ last {e.windowMin} min of the transcript</div>}
                    </div>
                  );
                }
                return <ClaudeMessage key={i} e={e} />;
              })}
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="ap-col">
      {(st.tabs.length > 0 || view !== 'off') && (
        <div className="ap-tabrow" ref={tabRowRef}>
          <div className="ap-tabs" role="tablist" aria-label="Projects">
            {st.tabs.map((t) => {
              const mark = t.state === 'starting' || t.state === 'busy' || t.state === 'ready' || t.state === 'restarting' ? 'run'
                : t.state === 'error' || t.state === 'claude-unavailable' || t.state === 'session-off' ? 'err' : 'idle';
              const on = t.projectPath === st.active;
              return (
                <div key={t.projectPath} className={`ap-tab${on ? ' ap-tab--on' : ''}`}>
                  <button type="button" role="tab" aria-selected={on} className="ap-tn" onClick={() => assistantStore.setActive(t.projectPath)} title={t.projectPath}>
                    {t.name}{' '}
                    <span className={`ap-mk ap-mk--${mark}`} role="img" aria-label={mark === 'run' ? 'session running' : mark === 'idle' ? 'not started' : 'session unavailable'}>
                      {mark === 'run' ? '●' : mark === 'idle' ? '○' : '!'}
                    </span>
                  </button>
                  <button type="button" className="ap-tx" aria-label={`Close tab ${t.name}`} onClick={() => assistantStore.closeTab(t.projectPath)}>&times;</button>
                </div>
              );
            })}
          </div>
          <button type="button" className="ap-plus" aria-label="Open project" aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)}>+</button>
          {pickerOpen && <Picker tabs={st.tabs} projects={projects} recentPaths={recentPaths} onPicked={() => setPickerOpen(false)} />}
        </div>
      )}
      <div
        className="ap-body"
        ref={bodyRef}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {renderBody()}
      </div>
      <div className="ap-inp">
        <div className="ap-inrow">
          <textarea
            ref={inputRef}
            rows={2}
            maxLength={4000}
            aria-label="Question"
            value={disabledReason ? '' : draft}
            placeholder={disabledReason ?? `Ask about ${tab?.name ?? 'the project'}…`}
            disabled={disabledReason !== null}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {streaming ? (
            <button type="button" className="ap-btn ap-btn--red" onClick={() => assistantStore.stop()}>Stop</button>
          ) : (
            <button type="button" className="ap-btn ap-btn--primary" disabled={disabledReason !== null || !draft.trim()} onClick={send}>Send</button>
          )}
        </div>
        <div className="ap-inhint">{st.transcript ? <>Enter to send &middot; Shift+Enter new line &middot; sends your question with the last {st.windowMin} min of the transcript</> : 'Enter to send · Shift+Enter new line · Live text is off: Claude answers from the project notes and the action items'}</div>
      </div>
      {tab && !blocked && (
        <div className="ap-foot">
          <span className="ap-foot-sp" />
          <button type="button" className="ap-btn ap-btn--plain" onClick={() => assistantStore.stopSession()}>Stop session</button>
        </div>
      )}
    </div>
  );
};

export default AssistantColumn;
