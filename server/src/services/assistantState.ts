import { AI_DEFAULTS, sanitizeAiModel, sanitizeBudgetUsd, sanitizeTranscriptWindow, type AiModel, type PreferencesRecord } from './preferencesStore.js';
import { AI_MIN_CLAUDE_VERSION, type ClaudeProbe } from './claudeCli.js';

export { AI_MIN_CLAUDE_VERSION };
export const AI_SESSION_CONSENT_VERSION = 1;
export const AI_COPILOT_CONSENT_VERSION = 1;
export const PRAXIS_HEALTH_URL = 'http://127.0.0.1:7865/health';
export const COPILOT_MODES = ['off', 'local', 'claude', 'always'] as const;
export type CopilotMode = (typeof COPILOT_MODES)[number];

export interface AssistantStatus {
  claude: ClaudeProbe; // {found, signedIn, version, tooOld, checkedAt} — never the path
  praxis: { reachable: boolean };
  copilot: { mode: CopilotMode; consentStale: boolean; model: AiModel; alwaysBudgetUsd: number };
  session: { enabled: boolean; consentStale: boolean; consentAt: string | null; model: AiModel; budgetUsd: number; transcriptWindowMin: number };
}

export type RuleResult = { ok: true; prefs: PreferencesRecord } | { ok: false; status: 400 | 409; error: string };

export function isClaudeUsable(c: ClaudeProbe): boolean {
  return c.found && c.signedIn && !c.tooOld;
}

export function readConsent(v: unknown): { acceptedAt: string; version: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.acceptedAt !== 'string' || typeof o.version !== 'number' || !Number.isFinite(o.version)) return null;
  return { acceptedAt: o.acceptedAt, version: o.version };
}

function savedCopilotMode(prefs: PreferencesRecord): CopilotMode {
  const m = prefs.aiCopilotMode;
  return typeof m === 'string' && (COPILOT_MODES as readonly string[]).includes(m) ? (m as CopilotMode) : 'off';
}

export function buildAssistantStatus(prefs: PreferencesRecord, claude: ClaudeProbe, praxisReachable: boolean): AssistantStatus {
  const mode = savedCopilotMode(prefs);
  const consent = readConsent(prefs.aiCopilotConsent);
  const consentStale =
    (mode === 'claude' || mode === 'always') &&
    (!consent ||
      consent.version < AI_COPILOT_CONSENT_VERSION ||
      (mode === 'always' && !(prefs.aiCopilotAlwaysAck && typeof prefs.aiCopilotAlwaysAck === 'object')));

  const requested = prefs.aiSessionEnabled === true;
  const sc = readConsent(prefs.aiConsent);
  const valid = !!sc && sc.version >= AI_SESSION_CONSENT_VERSION;
  const enabled = requested && valid;

  return {
    claude,
    praxis: { reachable: praxisReachable },
    copilot: {
      mode,
      consentStale,
      model: sanitizeAiModel(prefs.aiCopilotModel) ?? AI_DEFAULTS.model,
      alwaysBudgetUsd: sanitizeBudgetUsd(prefs.aiCopilotAlwaysBudgetUsd) ?? AI_DEFAULTS.budgetUsd,
    },
    session: {
      enabled,
      consentStale: requested && !valid,
      consentAt: enabled ? sc!.acceptedAt : null,
      model: sanitizeAiModel(prefs.aiModel) ?? AI_DEFAULTS.model,
      budgetUsd: sanitizeBudgetUsd(prefs.aiSessionBudgetUsd) ?? AI_DEFAULTS.budgetUsd,
      transcriptWindowMin: sanitizeTranscriptWindow(prefs.aiTranscriptWindowMin) ?? AI_DEFAULTS.transcriptWindowMin,
    },
  };
}

function bodyOf(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function applyCopilotMode(prefs: PreferencesRecord, body: unknown, claudeUsable: boolean, now: Date = new Date()): RuleResult {
  const b = bodyOf(body);
  const mode = b.mode;
  if (typeof mode !== 'string' || !(COPILOT_MODES as readonly string[]).includes(mode)) {
    return { ok: false, status: 400, error: 'Unknown copilot mode.' };
  }
  if (mode === 'off' || mode === 'local') return { ok: true, prefs: { ...prefs, aiCopilotMode: mode } };
  if (mode === 'claude') {
    if (b.accept !== true) return { ok: false, status: 400, error: 'Consent is required.' };
    if (!claudeUsable) return { ok: false, status: 409, error: 'Claude Code is not available.' };
    return {
      ok: true,
      prefs: { ...prefs, aiCopilotMode: 'claude', aiCopilotConsent: { acceptedAt: now.toISOString(), version: AI_COPILOT_CONSENT_VERSION } },
    };
  }
  // always
  if (b.accept !== true || b.ack !== true) return { ok: false, status: 400, error: 'Consent and confirmation are required.' };
  if (!claudeUsable) return { ok: false, status: 409, error: 'Claude Code is not available.' };
  const at = now.toISOString();
  return {
    ok: true,
    prefs: {
      ...prefs,
      aiCopilotMode: 'always',
      aiCopilotConsent: { acceptedAt: at, version: AI_COPILOT_CONSENT_VERSION },
      aiCopilotAlwaysAck: { acceptedAt: at },
    },
  };
}

export function applySessionEnable(prefs: PreferencesRecord, body: unknown, claudeUsable: boolean, now: Date = new Date()): RuleResult {
  if (bodyOf(body).accept !== true) return { ok: false, status: 400, error: 'Consent is required.' };
  if (!claudeUsable) return { ok: false, status: 409, error: 'Claude Code is not available.' };
  return {
    ok: true,
    prefs: { ...prefs, aiSessionEnabled: true, aiConsent: { acceptedAt: now.toISOString(), version: AI_SESSION_CONSENT_VERSION } },
  };
}

export function applySessionDisable(prefs: PreferencesRecord): PreferencesRecord {
  const { aiConsent: _dropped, ...rest } = prefs;
  return { ...rest, aiSessionEnabled: false };
}

export async function probePraxisReachable(fetchImpl: typeof fetch = fetch, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetchImpl(PRAXIS_HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return false;
    const json = (await res.json()) as { status?: unknown } | null;
    return json?.status === 'ok';
  } catch {
    return false;
  }
}
