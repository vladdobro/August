// AUG-197: COPILOT column: mode strip + hint cards (searching -> found | explained) for the active project tab.
// Plain text only. Never shows model names (except the strip's model select), prices or token counts inside cards.
import React, { useState } from 'react';
import { assistantStore, baseName, copilotView, useAssistantStore, type CopilotHint } from '../../services/assistantStore';
import type { AiModel, CopilotMode } from '../../types';
import AlwaysOnConfirmModal from '../AlwaysOnConfirmModal';

const MODE_NAME: Record<CopilotMode, string> = { off: 'Off', local: 'Local hints', claude: 'Claude explains', always: 'Always-on Claude' };
const MODEL_NAME: Record<AiModel, string> = { sonnet: 'Sonnet', haiku: 'Haiku', opus: 'Opus' };

const NOTE_TEXT = {
  local: 'Local hints show the note as found; no explanation.',
  'claude-off': 'Shown without explanation — Claude is off for this meeting.',
  'claude-unavailable': 'Shown without explanation — Claude Code is not available.',
} as const;

interface CopilotColumnProps {
  onOpenSettings: (tab?: 'assistants') => void;
}

const HintCard: React.FC<{ hint: CopilotHint; projectName: string }> = ({ hint, projectName }) => {
  const label = hint.route || hint.taskId || 'this hint';
  if (hint.dismissed) {
    return (
      <div className="cp-dismrow">
        <span>Dismissed &middot; {label} &mdash; hidden for the rest of this meeting</span>
        <button type="button" className="ap-btn ap-btn--plain" onClick={() => assistantStore.undoDismiss(hint.hintId)}>Undo</button>
      </div>
    );
  }
  if (hint.state === 'searching') {
    return (
      <div className="cp-card cp-card--search">
        <div className="cp-meta"><span>{hint.clock}</span><span>&middot;</span><span>{projectName}</span></div>
        <div className="cp-big">Looking for the earlier agreement&hellip;<span className="ap-caret" aria-hidden="true" /></div>
        <div className="cp-acts">
          <button type="button" className="ap-btn ap-btn--plain" onClick={() => assistantStore.dismissHint(hint.hintId)}>Dismiss</button>
        </div>
      </div>
    );
  }
  const explained = hint.state === 'explained';
  const hasLines = !!hint.lines && hint.lines.length > 0;
  const linesShown = explained ? !!hint.showLines && hasLines : hasLines;
  return (
    <div className="cp-card">
      <div className="cp-meta">
        <span>{hint.clock}</span>
        {explained ? <span className="cp-tag">EXPLAINED</span> : <b>{label}</b>}
      </div>
      {explained && <div className="cp-big">{hint.text}</div>}
      {explained && hint.source && <div className="cp-src">Source: {hint.source}</div>}
      {linesShown && hint.lines!.map((l) => <div className="cp-sn" key={l.n}>L{l.n}: {l.text}</div>)}
      {!explained && !hasLines && hint.taskId && <div className="cp-sn">{hint.taskId}{hint.title ? ` — ${hint.title}` : ''}</div>}
      {!explained && hasLines && hint.taskId && hint.title && <div className="cp-sn">{hint.taskId} &mdash; {hint.title}</div>}
      {!explained && hint.note && <div className="cp-foot">{NOTE_TEXT[hint.note]}</div>}
      <div className="cp-acts">
        {hint.route && (
          <button type="button" className="ap-btn ap-btn--go" onClick={() => assistantStore.openHintRoute(hint.hintId)}>
            {hint.routeText != null && hint.routeText !== 'loading' ? 'Hide route' : 'Open route'}
          </button>
        )}
        <button type="button" className="ap-btn" onClick={() => assistantStore.askAboutHint(hint.hintId)}>Ask</button>
        {explained && hasLines && (
          <button type="button" className="ap-btn ap-btn--plain" onClick={() => assistantStore.toggleHintLines(hint.hintId)}>
            {hint.showLines ? 'Hide note lines' : 'Show note lines'}
          </button>
        )}
        <button type="button" className="ap-btn ap-btn--plain" onClick={() => assistantStore.dismissHint(hint.hintId)}>Dismiss</button>
      </div>
      {hint.routeText != null && (
        <div className="cp-route">
          {hint.routeText === 'loading' ? 'Loading…' : hint.routeText === 'error' ? 'Could not load the note.' : hint.routeText}
        </div>
      )}
    </div>
  );
};

const CopilotColumn: React.FC<CopilotColumnProps> = ({ onOpenSettings }) => {
  const st = useAssistantStore();
  const [alwaysOpen, setAlwaysOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tab = st.tabs.find((t) => t.projectPath === st.active) ?? null;

  if (!tab) {
    return (
      <div className="ap-col">
        <div className="ap-body"><div className="ap-empty">Pick a project in ASSISTANT to start hints.</div></div>
      </div>
    );
  }

  const cv = copilotView(st);
  const status = cv.status;
  const fallback = status?.state === 'claude-unavailable';
  const effective: CopilotMode = status?.mode ?? st.copilotMode;
  const claudeMode = (effective === 'claude' || effective === 'always') && !fallback;
  const claudeBlocked = st.claudeUsable === false;

  const pickMode = (mode: CopilotMode) => {
    if (busy || mode === st.copilotMode) return;
    setError(null);
    if (mode === 'always') {
      setAlwaysOpen(true);
      return;
    }
    setBusy(true);
    assistantStore.setCopilotMode(mode).then((msg) => { setError(msg); setBusy(false); });
  };

  const confirmAlways = () => {
    setBusy(true);
    assistantStore.setCopilotMode('always', { ack: true }).then((msg) => {
      setBusy(false);
      if (msg) setError(msg);
      else setAlwaysOpen(false);
    });
  };

  const pickModel = (model: AiModel) => {
    setError(null);
    assistantStore.setCopilotModel(model).then((msg) => setError(msg));
  };

  const strip = (
    <div className="ap-strip">
      <span>{fallback ? <><b>Local hints</b> (Claude Code not available)</> : <b>{MODE_NAME[effective]}</b>}</span>
      <span className="cp-sel">
        {claudeMode && (
          <select aria-label="Copilot model" value={st.copilotModel} onChange={(e) => pickModel(e.target.value as AiModel)}>
            {(['sonnet', 'haiku', 'opus'] as AiModel[]).map((m) => <option key={m} value={m}>{MODEL_NAME[m]}</option>)}
          </select>
        )}
        <select aria-label="Copilot mode" value={st.copilotMode} disabled={busy} onChange={(e) => pickMode(e.target.value as CopilotMode)}>
          <option value="off">{MODE_NAME.off}</option>
          <option value="local">{MODE_NAME.local}</option>
          <option value="claude" disabled={claudeBlocked}>{MODE_NAME.claude}</option>
          <option value="always" disabled={claudeBlocked}>{MODE_NAME.always}</option>
        </select>
        <button type="button" className="ap-link" onClick={() => onOpenSettings('assistants')}>Open Settings</button>
      </span>
    </div>
  );

  const modal = alwaysOpen && (
    <AlwaysOnConfirmModal
      budgetUsd={st.alwaysBudgetUsd}
      busy={busy}
      error={error}
      onCancel={() => { setAlwaysOpen(false); setError(null); }}
      onConfirm={confirmAlways}
    />
  );

  if (st.copilotMode === 'off') {
    return (
      <div className="ap-col">
        {strip}
        <div className="ap-body">
          {error && !alwaysOpen && <div className="ap-warn">{error}</div>}
          <div className="ap-empty">Copilot is off. Turn it on in Settings &rarr; AI assistants.</div>
        </div>
        {modal}
      </div>
    );
  }

  const counts = status
    ? status.state === 'paused' ? 'paused' : `${status.counts.shown} shown · ${status.counts.silent} checked silently`
    : '';

  return (
    <div className="ap-col">
      {strip}
      <div className="ap-body">
        {error && !alwaysOpen && <div className="ap-warn">{error}</div>}
        <div className="cp-hh">
          <div className="ap-blk-t">Hints</div>
          <div className="cp-cnt">{counts}</div>
        </div>
        {status?.state === 'praxis-off' && <div className="ap-warn">PraxisOS is not running. Hints are paused; they resume when it starts.</div>}
        {status?.state === 'budget-reached' && <div className="ap-warn">Spending limit reached &mdash; switched to Claude explains</div>}
        {cv.hints.length === 0
          ? <div className="ap-empty">Listening for references to past agreements.</div>
          : <div className="ap-stack">{cv.hints.map((h) => <HintCard key={h.hintId} hint={h} projectName={tab.name || baseName(tab.projectPath)} />)}</div>}
      </div>
      {modal}
    </div>
  );
};

export default CopilotColumn;
