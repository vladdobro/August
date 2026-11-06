import React, { useEffect, useRef, useState } from 'react';
import type { AssistantChannelAction, AssistantSnapshot, CompactExchange } from '../../services/assistantChannel';
import { useAssistantSnapshot } from './useAssistantSnapshot';
import './compactPanels.css';

const BLOCKED_TEXT: Partial<Record<AssistantSnapshot['view'], string>> = {
  none: 'Pick a Praxis project in the ASSISTANT column of the full window.',
  off: 'Active session is off. Turn it on in Settings → AI assistants to ask Claude about this project.',
  missing: 'Claude Code is not installed on this computer. Install it, sign in, then press Recheck in the full window.',
  'signed-out': 'Claude Code is installed but not signed in. Run claude in a terminal and sign in, then press Recheck in the full window.',
  'too-old': 'Claude Code is too old for the session. Update it, then press Recheck in the full window.',
  unsupported: 'This Claude Code install cannot run the session. Install the native build, then press Recheck in the full window.',
};

const WARN_TEXT: Partial<Record<AssistantSnapshot['view'], string>> = {
  budget: 'Spending limit reached for this meeting. Raise it in Settings → AI assistants; the conversation is kept.',
  limit: 'Three Claude sessions are already running. Stop a session in another tab to ask here.',
  error: 'The session stopped twice in a row. Ask again to start it fresh.',
};

function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

/// Plain-text answer: paragraphs and bullet lists, never HTML.
export const AnswerText: React.FC<{ text: string; streaming: boolean }> = ({ text, streaming }) => {
  const blocks = text.split(/\n{2,}/).map((b) => b.split('\n').filter((l) => l.trim() !== '')).filter((b) => b.length > 0);
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
  return (
    <>
      {blocks.map((lines, i) => {
        if (lines.every((l) => bullet.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{plain(l.replace(bullet, ''))}</li>)}</ul>;
        }
        return <p key={i}>{plain(lines.join(' '))}</p>;
      })}
      {streaming && <span className="cp-caret" aria-hidden="true">▍</span>}
    </>
  );
};

function taskLabel(task: NonNullable<NonNullable<CompactExchange['answer']>['task']>): string {
  if (task.state === 'creating') return 'Creating…';
  if (task.state === 'failed') return 'Task not created';
  return `✓ ${task.taskId ?? 'Task'}${task.direct ? ' (created directly)' : ''}`;
}

const Exchange: React.FC<{ ex: CompactExchange; send: (a: AssistantChannelAction) => void }> = ({ ex, send }) => {
  const a = ex.answer;
  return (
    <>
      <div className="kq"><b>YOU</b>{ex.question}</div>
      {a ? (
        <div className="kan">
          {a.tools.length > 0 && (
            <div className="ktools">
              {a.tools.map((t, i) => (
                <span key={i} className={`tchip${a.streaming && i === a.tools.length - 1 ? ' prog' : ''}`}>{t}</span>
              ))}
            </div>
          )}
          <AnswerText text={a.text} streaming={a.streaming} />
          {!a.streaming && a.text !== '' && (
            <div className="macts">
              <button
                type="button"
                className="btn"
                disabled={a.actionState !== undefined}
                onClick={() => send({ kind: 'to-action', askId: ex.askId })}
              >
                {a.actionState === 'added' ? '✓ Added' : a.actionState === 'duplicate' ? 'Already in the list' : '→ Action item'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={a.task?.state === 'creating' || a.task?.state === 'done'}
                onClick={() => send({ kind: 'to-task', askId: ex.askId })}
              >
                {a.task ? taskLabel(a.task) : '→ Praxis task'}
              </button>
              <button type="button" className="btn" onClick={() => send({ kind: 'copy', askId: ex.askId })}>Copy</button>
            </div>
          )}
        </div>
      ) : ex.noAnswer ? (
        <div className="kq">No answer — the session stopped while answering.</div>
      ) : null}
    </>
  );
};

const CompactAssistantApp: React.FC = () => {
  const { snap, send } = useAssistantSnapshot();
  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('panel-root');
    return () => document.documentElement.classList.remove('panel-root');
  }, []);

  const last = snap?.last ?? null;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.askId, last?.answer?.text, last?.answer?.tools.length]);

  const view = snap?.view ?? 'none';
  const live = snap?.live ?? false;
  const blocked = !snap || !live ? undefined : BLOCKED_TEXT[view];
  const warn = snap && live ? WARN_TEXT[view] ?? (snap.praxisDown ? 'PraxisOS is not running. Claude answers without the project notes.' : undefined) : undefined;
  const streaming = snap?.streaming ?? false;
  const disabledReason = !snap ? 'Waiting for the main window…' : !live ? 'Start a recording to ask about the project.' : snap.inputDisabledReason;
  const submit = (): void => {
    const text = draft.trim();
    if (!text || disabledReason || streaming) return;
    send({ kind: 'ask', text });
    setDraft('');
  };

  return (
    <div className="panel-win kbox">
      <div className="kh">
        <b>ASSISTANT</b>
        <span className="sp" />
        <button type="button" className="kb ic" onClick={() => window.august?.setCompactPanel?.('assistant', false)} aria-label="Close Assistant window" title="Close">×</button>
      </div>
      <div className="kdh">
        <span>Project</span>
        {snap && snap.tabs.length > 0 ? (
          <select
            className="sm"
            aria-label="Project"
            value={snap.activeProjectPath ?? ''}
            onChange={(e) => send({ kind: 'set-active', projectPath: e.target.value })}
          >
            {snap.tabs.map((t) => (
              <option key={t.projectPath} value={t.projectPath}>{t.mark === 'run' ? '● ' : t.mark === 'err' ? '! ' : '○ '}{t.name}</option>
            ))}
          </select>
        ) : (
          <span>no project</span>
        )}
      </div>
      <div className="kbody" ref={bodyRef}>
        {!snap ? (
          <div className="kemp">Waiting for the main window…</div>
        ) : !live ? (
          <div className="kemp">No recording is running.</div>
        ) : blocked ? (
          <div className="kemp">{blocked}</div>
        ) : last ? (
          <Exchange ex={last} send={send} />
        ) : (
          <div className="kemp">No questions yet.</div>
        )}
      </div>
      {warn && <div className="kmsg">{warn}</div>}
      <div className="kin">
        <input
          value={draft}
          maxLength={4000}
          disabled={Boolean(disabledReason)}
          placeholder={disabledReason ?? 'Ask about this project'}
          aria-label="Question"
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button type="button" className="kb r" onClick={() => send({ kind: 'stop' })}>Stop</button>
        ) : (
          <button type="button" className="kb s" onClick={submit} disabled={Boolean(disabledReason) || draft.trim() === ''} aria-label="Send">↵</button>
        )}
      </div>
    </div>
  );
};

export default CompactAssistantApp;
