import React, { useEffect } from 'react';
import type { AssistantSnapshot } from '../../services/assistantChannel';
import { useAssistantSnapshot } from './useAssistantSnapshot';
import './compactPanels.css';

const MODE_NAME: Record<AssistantSnapshot['copilot']['mode'], string> = {
  off: 'Off',
  local: 'Local hints',
  claude: 'Claude explains',
  always: 'Always-on Claude',
};

const CompactCopilotApp: React.FC = () => {
  const { snap, send } = useAssistantSnapshot();

  useEffect(() => {
    document.documentElement.classList.add('panel-root');
    return () => document.documentElement.classList.remove('panel-root');
  }, []);

  const mode = snap?.copilot.mode ?? 'off';
  let body: React.ReactNode;
  if (!snap) body = <div className="kemp">Waiting for the main window…</div>;
  else if (!snap.transcript) body = <div className="kemp">Hints need live text.</div>; // AUG-200
  else if (mode === 'off') body = <div className="kemp">Copilot is off. Turn it on in Settings → AI assistants.</div>;
  else if (snap.tabs.length === 0) body = <div className="kemp">Pick a project in ASSISTANT to start hints.</div>;
  else if (snap.praxisDown || snap.copilot.statusText?.startsWith('PraxisOS')) body = <div className="kemp">Hints are paused until PraxisOS starts.</div>;
  else {
    const hint = snap.copilot.hints[0];
    const more = snap.copilot.hintCount - 1;
    body = (
      <>
        {snap.copilot.statusText && <div className="kemp">{snap.copilot.statusText}</div>}
        {hint ? (
          <div className="kan kan--hint">
            {hint.title && <div className="kan-t">{hint.title}</div>}
            {hint.state === 'searching'
              ? <div>Looking for the earlier agreement&hellip;</div>
              : <div>{hint.state === 'explained' || !hint.title ? hint.text : `${hint.title} — ${hint.text}`}</div>}
            <div className="kan-acts">
              {hint.state !== 'searching' && <button type="button" className="kb" onClick={() => send({ kind: 'copilot-ask', hintId: hint.hintId })}>Ask</button>}
              <button type="button" className="kb" onClick={() => send({ kind: 'copilot-dismiss', hintId: hint.hintId })}>Dismiss</button>
            </div>
          </div>
        ) : !snap.copilot.statusText && <div className="kemp">Listening for references to past agreements.</div>}
        {more > 0 && <button type="button" className="kmore" onClick={() => send({ kind: 'show-copilot' })}>{more} more in the full window</button>}
      </>
    );
  }

  return (
    <div className="panel-win kbox">
      <div className="kh">
        <b>COPILOT</b>
        <span className="sp" />
        <button type="button" className="kb ic" onClick={() => window.august?.setCompactPanel?.('copilot', false)} aria-label="Close Copilot window" title="Close">×</button>
      </div>
      <div className="kdh"><span>Copilot · {snap?.copilot.fallbackLocal ? 'Local hints' : MODE_NAME[mode]}</span>
        {snap?.copilot.hints[0]?.title && <span className="kan-t">{snap.copilot.hints[0].title}</span>}</div>
      <div className="kbody">{body}</div>
    </div>
  );
};

export default CompactCopilotApp;
