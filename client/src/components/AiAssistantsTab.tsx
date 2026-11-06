import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UserPreferences } from '../services/preferences';
import { DEFAULT_PREFERENCES } from '../services/preferences';
import { disableAssistantSession, enableAssistantSession, fetchAssistantStatus, setCopilotMode } from '../api';
import type { AiModel, AssistantStatus, CopilotMode } from '../types';
import SettingsDropdown from './SettingsDropdown';
import AlwaysOnConfirmModal from './AlwaysOnConfirmModal';

/// AUG-198: Settings → AI assistants. Spec docs/mockups/AUG-194/findings.md; markup mirrors the final mockup.

interface Props {
  preferences: UserPreferences;
  onPreferenceChange: (patch: Partial<UserPreferences>) => void;
  onModalChange: (open: boolean) => void;
}

const MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet — balanced (default)' },
  { value: 'haiku', label: 'Haiku — cheapest, fastest' },
  { value: 'opus', label: 'Opus — strongest, costliest' },
];
const WINDOW_OPTIONS = [
  { value: '2', label: '2 min' },
  { value: '5', label: '5 min (default)' },
  { value: '10', label: '10 min' },
  { value: '15', label: '15 min' },
];
const formatUsd = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const NO_LIMIT_HINT = 'No limit: usage is capped only by your Claude plan.';

interface ModeDef {
  id: CopilotMode;
  name: string;
  tag?: 'accent' | 'danger';
  claude?: boolean;
  desc: string;
  price: string;
}
const MODES: ModeDef[] = [
  { id: 'off', name: 'Off', desc: 'No hints.', price: 'Free · nothing is sent' },
  {
    id: 'local',
    name: 'Local hints',
    desc: 'Spots references to past agreements and shows matching notes from the Praxis project. Finds less in meetings that are not in the notes’ language.',
    price: 'Free · runs on this computer, nothing is sent',
  },
  {
    id: 'claude',
    name: 'Claude explains',
    tag: 'accent',
    claude: true,
    desc: 'Same trigger; Claude checks the found notes, searches the project when needed and says in one sentence what was agreed.',
    price: 'About $0.10–0.20 per meeting hour of your Claude usage · sends only the few lines around each reference and the matching notes',
  },
  {
    id: 'always',
    name: 'Always-on Claude',
    tag: 'danger',
    claude: true,
    desc: 'Claude reads the whole meeting and decides itself when to show a hint. Catches references without trigger words.',
    price: 'About $1–2.50 per meeting hour · the whole conversation is sent to Anthropic as it happens',
  },
];

const MoneyField: React.FC<{ value: number; disabled: boolean; onCommit: (n: number) => void }> = ({ value, disabled, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const t = draft.trim();
    const n = Number(t);
    if (t === '' || !Number.isFinite(n) || n < 0) {
      setDraft(String(value));
      return;
    }
    const r = Math.min(1000, Math.round(n * 100) / 100);
    setDraft(String(r));
    if (r !== value) onCommit(r);
  };
  return (
    <span className="settings-money">
      $
      <input
        className="settings-input"
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        placeholder="0 = no limit"
        aria-label="Spending limit per meeting in USD"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </span>
  );
};

const AiAssistantsTab: React.FC<Props> = ({ preferences, onPreferenceChange, onModalChange }) => {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [modal, setModal] = useState<'consent' | 'always' | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    fetchAssistantStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onModalChange(modal !== null), [modal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onModalChange(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const usable = !!status && status.claude.found && status.claude.signedIn && !status.claude.tooOld;
  const praxisUp = status?.praxis.reachable ?? true;

  const cpModel = preferences.aiCopilotModel ?? DEFAULT_PREFERENCES.aiCopilotModel;
  const alwaysBudget = preferences.aiCopilotAlwaysBudgetUsd ?? DEFAULT_PREFERENCES.aiCopilotAlwaysBudgetUsd;
  const sModel = preferences.aiModel ?? DEFAULT_PREFERENCES.aiModel;
  const sBudget = preferences.aiSessionBudgetUsd ?? DEFAULT_PREFERENCES.aiSessionBudgetUsd;
  const sWindow = preferences.aiTranscriptWindowMin ?? DEFAULT_PREFERENCES.aiTranscriptWindowMin;

  const cancelModal = () => {
    if (modal === 'consent' && modalError) setEnableError(modalError);
    setModal(null);
    setModalError(null);
  };

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelModal();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }); // re-registered each render so cancelModal sees current state

  const recheck = () => {
    if (checking) return;
    setChecking(true);
    fetchAssistantStatus(true)
      .then((s) => {
        setStatus(s);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setChecking(false));
  };

  const postMode = (mode: CopilotMode, opts: { accept?: boolean; ack?: boolean } = {}) => {
    setCopilotBusy(true);
    setCopilotError(null);
    setCopilotMode(mode, opts)
      .then(setStatus)
      .catch((err: Error) => setCopilotError(err.message || 'Something went wrong.'))
      .finally(() => setCopilotBusy(false));
  };

  const pickMode = (id: CopilotMode) => {
    if (!status || copilotBusy) return;
    const def = MODES.find((m) => m.id === id);
    if (def?.claude && !usable) return;
    if (id === 'always') {
        setModalError(null);
      setModal('always');
    } else if (id === 'claude') {
      postMode('claude', { accept: true });
    } else if (status.copilot.mode !== id) {
      postMode(id);
    }
  };

  const confirmAlways = () => {
    setCopilotBusy(true);
    setModalError(null);
    setCopilotMode('always', { accept: true, ack: true })
      .then((s) => {
        setStatus(s);
        setModal(null);
          })
      .catch((err: Error) => setModalError(err.message || 'Something went wrong.'))
      .finally(() => setCopilotBusy(false));
  };

  const confirmConsent = () => {
    setSessionBusy(true);
    setModalError(null);
    enableAssistantSession()
      .then((s) => {
        setStatus(s);
        setModal(null);
        setEnableError(null);
      })
      .catch((err: Error) => setModalError(err.message || 'Something went wrong.'))
      .finally(() => setSessionBusy(false));
  };

  const toggleSession = (on: boolean) => {
    if (on) {
      setEnableError(null);
      setModalError(null);
      setModal('consent');
      return;
    }
    setSessionBusy(true);
    setEnableError(null);
    disableAssistantSession()
      .then(setStatus)
      .catch((err: Error) => setEnableError(err.message || 'Something went wrong.'))
      .finally(() => setSessionBusy(false));
  };

  const statusSpan = (text: string, warn: boolean) => (
    <span className={`settings-status${warn ? ' settings-status--warn' : ''}`}>{text}</span>
  );

  let claudeText: React.ReactNode;
  if (checking || !status) claudeText = statusSpan('Checking…', false);
  else if (!status.claude.found) claudeText = statusSpan('Not installed', true);
  else if (status.claude.tooOld) claudeText = statusSpan(`Too old (${status.claude.version ?? '?'}) — update it`, true);
  else if (!status.claude.signedIn) claudeText = statusSpan('Installed, not signed in', true);
  else claudeText = statusSpan(`Signed in · ${status.claude.version ?? ''}`, false);

  const praxisText = !status ? statusSpan('Checking…', false) : status.praxis.reachable ? statusSpan('Running', false) : statusSpan('Not running', true);

  const claudeKnown = !!status && !checking;
  const showRecheck = (loadError || !usable || !praxisUp) && (!!status || loadError);

  const modelRow = (disabled: boolean) => (
    <div className="settings-row">
      <span className="settings-label">Model</span>
      <SettingsDropdown
        className="settings-dropdown--fit"
        value={cpModel}
        options={MODEL_OPTIONS}
        disabled={disabled}
        onChange={(v) => onPreferenceChange({ aiCopilotModel: v as AiModel })}
      />
    </div>
  );

  const copilotSection = (s: AssistantStatus) => {
    const mode = s.copilot.mode;
    return (
      <div className="settings-section">
        <div className="settings-section-title">Meeting Copilot</div>
        <div className="settings-choice-list" role="radiogroup" aria-label="Meeting Copilot mode">
          {MODES.map((m) => {
            const sel = mode === m.id;
            const dis = !!m.claude && !usable;
            return (
              <React.Fragment key={m.id}>
                <div
                  className={`settings-choice${sel ? ' settings-choice--selected' : ''}${dis ? ' settings-choice--disabled' : ''}`}
                  role="radio"
                  tabIndex={dis ? -1 : 0}
                  aria-checked={sel}
                  aria-disabled={dis || undefined}
                  onClick={() => pickMode(m.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pickMode(m.id);
                    }
                  }}
                >
                  <span className="settings-choice-mark" />
                  <div>
                    <div className="settings-choice-name">
                      {m.name}
                      {m.tag && (
                        <span className={`settings-tag settings-tag--${m.tag}`}>{m.tag === 'accent' ? 'RECOMMENDED' : 'EXPENSIVE'}</span>
                      )}
                    </div>
                    <div className="settings-choice-desc">{m.desc}</div>
                  </div>
                  <div className="settings-choice-price">{m.price}</div>
                </div>
                {sel && m.claude && (
                  <>
                    {!usable && !checking && (
                      <div className="settings-hint settings-hint--warn">Claude Code is not available — hints are shown without explanation until it is.</div>
                    )}
                    {s.copilot.consentStale && (
                      <div className="settings-hint settings-hint--warn">What this mode sends has changed since you chose it. Choose it again to confirm.</div>
                    )}
                    <div className={`settings-child${usable ? '' : ' settings-child--off'}`}>
                      {m.id === 'claude' ? (
                        <>
                          <div className="settings-hint">Choosing this mode allows August to send the lines around each reference and the matching notes to Anthropic through your Claude account.</div>
                          {modelRow(!usable)}
                        </>
                      ) : (
                        <>
                          {modelRow(!usable)}
                          <div className="settings-row">
                            <span className="settings-label">Spending limit per meeting</span>
                            <MoneyField value={alwaysBudget} disabled={!usable} onCommit={(n) => onPreferenceChange({ aiCopilotAlwaysBudgetUsd: n })} />
                          </div>
                          <div className="settings-hint">
                            {alwaysBudget === 0 ? NO_LIMIT_HINT : 'At the limit the copilot switches to Claude explains for the rest of the meeting. Enter 0 for no limit.'}
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </React.Fragment>
            );
          })}
        </div>
        {mode !== 'off' && !praxisUp && <div className="settings-hint settings-hint--warn">PraxisOS is not running. Hints start when it is.</div>}
        {copilotError && <div className="settings-hint settings-hint--warn">{copilotError}</div>}
        <div className="settings-hint">The copilot is off by default. You can switch modes during a meeting from the ASSISTANT panel.</div>
      </div>
    );
  };

  const sessionSection = (s: AssistantStatus) => {
    const sessionOn = s.session.enabled;
    const checked = sessionOn || modal === 'consent';
    const childOn = sessionOn && usable;
    return (
      <div className="settings-section">
        <div className="settings-section-title">Active session (Claude)</div>
        <div className="settings-row">
          <span className="settings-label">Active session</span>
          <label className="settings-toggle">
            <input type="checkbox" checked={checked} disabled={!usable || sessionBusy} onChange={(e) => toggleSession(e.target.checked)} />
            <span className="settings-toggle-label">{checked ? 'On' : 'Off'}</span>
          </label>
        </div>
        <div className="settings-hint">
          A chat with Claude bound to a project of your choice during the meeting. It answers from the project notes, adds action items and creates Praxis tasks. Text is sent only when you ask.
        </div>
        {!usable && <div className="settings-hint">Needs Claude Code — see Status above.</div>}
        {s.session.consentStale && (
          <div className="settings-hint settings-hint--warn">What the session sends has changed since you agreed. Turn it on again to review and confirm.</div>
        )}
        {enableError && modal !== 'consent' && <div className="settings-hint settings-hint--warn">{enableError}</div>}
        <div className={`settings-child${childOn ? '' : ' settings-child--off'}`}>
          <div className="settings-row">
            <span className="settings-label">Model</span>
            <SettingsDropdown
              className="settings-dropdown--fit"
              value={sModel}
              options={MODEL_OPTIONS}
              disabled={!childOn}
              onChange={(v) => onPreferenceChange({ aiModel: v as AiModel })}
            />
          </div>
          <div className="settings-hint">Billed to your Claude plan.</div>
          <div className="settings-row">
            <span className="settings-label">Spending limit per meeting</span>
            <MoneyField value={sBudget} disabled={!childOn} onCommit={(n) => onPreferenceChange({ aiSessionBudgetUsd: n })} />
          </div>
          <div className="settings-hint">{sBudget === 0 ? NO_LIMIT_HINT : 'The session stops answering when the limit is reached. Enter 0 for no limit.'}</div>
          <div className="settings-row">
            <span className="settings-label">Transcript window</span>
            <SettingsDropdown
              className="settings-dropdown--fit"
              value={String(sWindow)}
              options={WINDOW_OPTIONS}
              disabled={!childOn}
              onChange={(v) => onPreferenceChange({ aiTranscriptWindowMin: Number(v) as 2 | 5 | 10 | 15 })}
            />
          </div>
          <div className="settings-hint">How much recent transcript goes with each question.</div>
        </div>
      </div>
    );
  };

  const consentModal = (
    <div className="groq-setup-backdrop" onClick={(e) => { e.stopPropagation(); cancelModal(); }}>
      <div className="groq-setup-card" role="dialog" aria-modal="true" aria-labelledby="ai-consent-title" onClick={(e) => e.stopPropagation()}>
        <div className="groq-setup-header">
          <span className="groq-setup-icon">✦</span>
          <span id="ai-consent-title">Active session (Claude)</span>
        </div>
        <ol className="groq-setup-steps groq-setup-steps--lettered">
          <li>
            A) When you ask a question during a live recording, the last <strong>{sWindow} minutes</strong> of the transcript, the participant names you entered, the collected action items and your question are sent to Anthropic. Nothing is sent until you ask.
          </li>
          <li>
            B) It goes through Claude Code under your own Claude account, the same way as using Claude Code in a terminal. Claude may also read files in the project folder you pick for the meeting.
          </li>
          <li>
            C) Usage counts against your Claude plan — no API key is needed.{' '}
            {sBudget === 0 ? (
              'You chose no spending limit, so usage is capped only by your plan.'
            ) : (
              <>The session stops at your spending limit of <strong>${formatUsd(sBudget)}</strong> per meeting.</>
            )}
          </li>
        </ol>
        <p className="groq-setup-hint">You can turn this off at any time here. Meeting Copilot hints are covered by the mode you choose above, not by this consent.</p>
        {modalError && <div className="groq-setup-error">{modalError}</div>}
        <div className="groq-setup-actions">
          <button type="button" className="groq-setup-btn" disabled={sessionBusy} onClick={cancelModal}>Cancel</button>
          <button type="button" className="groq-setup-btn groq-setup-btn--primary" autoFocus disabled={sessionBusy} onClick={confirmConsent}>Agree and enable</button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-title">Status</div>
        <div className="settings-row">
          <span className="settings-label">Claude Code</span>
          {claudeText}
        </div>
        <div className="settings-row">
          <span className="settings-label">PraxisOS</span>
          {praxisText}
        </div>
        {claudeKnown && status && !status.claude.found && (
          <div className="settings-hint settings-hint--warn">
            Claude Code is not installed. Install it, run <code className="settings-code">claude</code> once in a terminal to sign in, then press Recheck.
          </div>
        )}
        {claudeKnown && status && status.claude.found && !status.claude.tooOld && !status.claude.signedIn && (
          <div className="settings-hint settings-hint--warn">
            Claude Code is installed but not signed in. Run <code className="settings-code">claude</code> once in a terminal, sign in through the browser, then press Recheck.
          </div>
        )}
        {claudeKnown && status && status.claude.found && status.claude.tooOld && (
          <div className="settings-hint settings-hint--warn">
            Claude Code is older than 2.1.318 and cannot report its sign-in. Run <code className="settings-code">claude update</code>, then press Recheck.
          </div>
        )}
        {status && !status.praxis.reachable && (
          <div className="settings-hint settings-hint--warn">PraxisOS is not running. Copilot hints start when it is; the Active session can still read project files.</div>
        )}
        {loadError && <div className="settings-hint settings-hint--warn">Could not check the assistants. Press Recheck.</div>}
        {showRecheck && (
          <div className="settings-recheck">
            <button type="button" className="settings-btn-inline" disabled={checking} onClick={recheck}>
              {checking ? 'Checking…' : 'Recheck'}
            </button>
          </div>
        )}
      </div>
      {status && copilotSection(status)}
      {status && sessionSection(status)}
      <div className="settings-section">
        <div className="settings-hint">Both assistants are off by default. Transcripts stay on this computer unless a mode above says otherwise.</div>
      </div>
      {modal === 'consent' && createPortal(consentModal, document.body)}
      {modal === 'always' && (
        <AlwaysOnConfirmModal budgetUsd={alwaysBudget} busy={copilotBusy} error={modalError} onCancel={cancelModal} onConfirm={confirmAlways} />
      )}
    </>
  );
};

export default AiAssistantsTab;
