// AUG-199: client state of the meeting assistant (ASSISTANT column + the compact windows through assistantChannel).
// One WebSocket (the live one, owned by FileUpload) carries every frame; this store only reduces them.
// Never holds or shows money, model names, token counts or tool names.
import { useSyncExternalStore } from 'react';
import { fetchAssistantStatus, fetchCopilotRoute, setCopilotMode as postCopilotMode } from '../api';
import type { AiModel, AssistantServerFrame, AssistantState, AssistantStatus, AssistantUnavailableReason, CopilotHintFrame, CopilotMode, CopilotServerFrame, CopilotStatusFrame } from '../types';
import { patchPreferences } from './preferences';
import { ASSISTANT_CHANNEL, type AssistantChannelMessage, type AssistantSnapshot, type CompactExchange } from './assistantChannel';
import { writeClipboard } from './clipboard';
import { compactStore } from './compactStore';
import { liveColumnsStore } from './liveColumnsStore';

export interface AssistantTransport {
  open(projectPath: string): void;
  ask(projectPath: string, text: string, askId: string): void;
  task(projectPath: string, askId: string, messageId: string): void;
  stop(projectPath: string, interrupt?: boolean): void;
  addItem(text: string, owner: string, assistant: { projectPath: string; messageId?: string }): void;
  copilotOpen(projectPath: string): void;
  copilotClose(projectPath: string): void;
  copilotDismiss(projectPath: string, hintId: string, undo?: boolean): void;
  copilotMode(mode?: CopilotMode, model?: AiModel): void;
}

/// AUG-197: a hint card; the flags are local to this window.
export type CopilotHint = CopilotHintFrame & { dismissed?: boolean; showLines?: boolean; routeText?: string | null | 'loading' | 'error' };
export interface CopilotTabState { status: CopilotStatusFrame | null; hints: CopilotHint[] }
const MAX_HINTS = 30;
const EMPTY_COPILOT: CopilotTabState = { status: null, hints: [] };

export interface ToolChip { index: number; label: string; state: 'running' | 'done' | 'failed' }
export type TaskInfo = { state: 'creating' | 'done' | 'failed'; taskId?: string; direct?: boolean };
export type ChatEntry =
  | { kind: 'user'; askId: string; text: string; windowMin: number; transcript?: boolean }
  | { kind: 'claude'; askId: string; text: string; tools: ToolChip[]; streaming: boolean; actionState?: 'added' | 'duplicate'; task?: TaskInfo }
  | { kind: 'noanswer'; askId: string; question: string }
  | { kind: 'system'; text: string };

export interface AssistantTab {
  projectPath: string;
  name: string;
  state: AssistantState;
  reason?: AssistantUnavailableReason;
  praxis: boolean;
  chat: ChatEntry[];
  streamingAskId: string | null;
}

export interface AssistantStoreState {
  live: boolean;
  transcript: boolean; // AUG-200: a Live Text client feeds the transcript (false on the meeting-only socket)
  enabled: boolean | null;
  claude: { found: boolean; signedIn: boolean; tooOld: boolean } | null;
  praxisReachable: boolean | null;
  windowMin: number;
  copilotMode: CopilotMode;
  copilotModel: AiModel;
  alwaysBudgetUsd: number;
  claudeUsable: boolean | null;
  copilot: Record<string, CopilotTabState>;
  assistPrefill: { text: string; nonce: number } | null;
  tabs: AssistantTab[];
  active: string | null;
}

export type AssistantView = AssistantSnapshot['view'];

const MAX_QUESTION = 4000;
const MAX_ITEM_TEXT = 300;

let state: AssistantStoreState = {
  live: false,
  transcript: false,
  enabled: null,
  claude: null,
  praxisReachable: null,
  windowMin: 5,
  copilotMode: 'off',
  copilotModel: 'sonnet',
  alwaysBudgetUsd: 2,
  claudeUsable: null,
  copilot: {},
  assistPrefill: null,
  tabs: [],
  active: null,
};
let transport: AssistantTransport | null = null;
const listeners = new Set<() => void>();

const pathKey = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function clock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/// First paragraph of an answer as plain text (markdown markers stripped), at most 300 chars.
export function firstParagraphPlain(text: string): string {
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 0) ?? '';
  const plain = para
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}(#{1,6}\s+|[-*+•]\s+|>\s+|\d+[.)]\s+)/, ''))
    .join(' ')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > MAX_ITEM_TEXT ? `${plain.slice(0, MAX_ITEM_TEXT - 1).trimEnd()}…` : plain;
}

function mapTab(s: AssistantStoreState, path: string, fn: (t: AssistantTab) => AssistantTab): AssistantStoreState {
  const key = pathKey(path);
  let hit = false;
  const tabs = s.tabs.map((t) => {
    if (pathKey(t.projectPath) !== key) return t;
    hit = true;
    return fn(t);
  });
  return hit ? { ...s, tabs } : s;
}

function mapClaude(chat: ChatEntry[], askId: string, fn: (e: Extract<ChatEntry, { kind: 'claude' }>) => Extract<ChatEntry, { kind: 'claude' }>): ChatEntry[] {
  return chat.map((e) => (e.kind === 'claude' && e.askId === askId ? fn(e) : e));
}

function set(next: AssistantStoreState): void {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
  schedulePublish();
}

function activeTab(s: AssistantStoreState = state): AssistantTab | null {
  if (!s.active) return null;
  const key = pathKey(s.active);
  return s.tabs.find((t) => pathKey(t.projectPath) === key) ?? null;
}

/// What the ASSISTANT column (and the compact window) shows for the active tab.
export function deriveView(s: AssistantStoreState): AssistantView {
  const tab = activeTab(s);
  if (!tab) return s.enabled === false ? 'off' : 'none';
  if (s.enabled === false || tab.state === 'session-off') return 'off';
  if (s.claude) {
    if (!s.claude.found) return 'missing';
    if (!s.claude.signedIn) return 'signed-out';
    if (s.claude.tooOld) return 'too-old';
  }
  if (tab.state === 'claude-unavailable') return tab.reason === 'signed-out' ? 'signed-out' : tab.reason === 'too-old' ? 'too-old' : tab.reason === 'unsupported' ? 'unsupported' : 'missing';
  if (tab.state === 'budget-reached') return 'budget';
  if (tab.state === 'limit') return 'limit';
  if (tab.state === 'error') return 'error';
  return 'ready';
}

const BLOCKED_VIEWS: AssistantView[] = ['none', 'off', 'missing', 'signed-out', 'too-old', 'unsupported'];
export const isBlockedView = (v: AssistantView): boolean => BLOCKED_VIEWS.includes(v);

export function praxisIsDown(s: AssistantStoreState): boolean {
  const tab = activeTab(s);
  return s.praxisReachable === false || (tab !== null && !tab.praxis);
}

/// Plain-text placeholder when the input is off; null when the question can be sent.
export function inputDisabledReason(s: AssistantStoreState): string | null {
  const v = deriveView(s);
  if (!s.live) return 'No recording is running';
  if (v === 'none') return 'Pick a project first';
  if (v === 'off') return 'Active session is off';
  if (v === 'missing' || v === 'signed-out' || v === 'too-old' || v === 'unsupported') return 'Claude Code is not available';
  if (v === 'budget') return 'Spending limit reached';
  return null;
}

/// Copilot state of the active tab (never null).
export function copilotView(s: AssistantStoreState = state): CopilotTabState {
  return (s.active && s.copilot[pathKey(s.active)]) || EMPTY_COPILOT;
}

const isShown = (h: CopilotHint) => (h.state === 'found' || h.state === 'explained') && !h.dismissed;

/// Hint count for the `CTX n` badge: found / explained hints of the active tab that are not dismissed.
export function copilotHintCount(s: AssistantStoreState = state): number {
  if (!s.transcript) return 0;
  return copilotView(s).hints.filter(isShown).length;
}

export function useCopilotHintCount(): number {
  return useSyncExternalStore(assistantStore.subscribe, () => copilotHintCount(state));
}

function hintAskText(h: CopilotHint): string {
  return 'Tell me more about ' + (h.source || h.route || h.taskId || 'this note') + (h.text ? ': ' + h.text : '');
}

function mapCopilot(s: AssistantStoreState, path: string, fn: (c: CopilotTabState) => CopilotTabState): AssistantStoreState {
  const key = pathKey(path);
  const cur = s.copilot[key] ?? EMPTY_COPILOT;
  const next = fn(cur);
  return next === cur ? s : { ...s, copilot: { ...s.copilot, [key]: next } };
}

function mapHint(s: AssistantStoreState, path: string, hintId: string, fn: (h: CopilotHint) => CopilotHint): AssistantStoreState {
  return mapCopilot(s, path, (c) => (c.hints.some((h) => h.hintId === hintId) ? { ...c, hints: c.hints.map((h) => (h.hintId === hintId ? fn(h) : h)) } : c));
}

/// AUG-197: copilot-hint / copilot-status frames.
function applyCopilotFrame(frame: CopilotServerFrame): void {
  if (!frame || typeof frame.projectPath !== 'string') return;
  if (frame.type === 'copilot-status') {
    set(mapCopilot(state, frame.projectPath, (c) => ({ ...c, status: frame })));
    return;
  }
  if (frame.type !== 'copilot-hint') return;
  set(mapCopilot(state, frame.projectPath, (c) => {
    const at = c.hints.findIndex((h) => h.hintId === frame.hintId);
    if (frame.state === 'removed') return at < 0 ? c : { ...c, hints: c.hints.filter((_, i) => i !== at) };
    if (at >= 0) {
      const old = c.hints[at];
      const merged: CopilotHint = { ...frame, dismissed: old.dismissed, showLines: old.showLines, routeText: old.routeText };
      return { ...c, hints: c.hints.map((h, i) => (i === at ? merged : h)) };
    }
    return { ...c, hints: [frame as CopilotHint, ...c.hints].slice(0, MAX_HINTS) };
  }));
}

// ---------- frame reducer ----------

function applyFrame(frame: AssistantServerFrame): void {
  const path = frame.projectPath;
  switch (frame.type) {
    case 'assistant-status': {
      set(mapTab(state, path, (t) => {
        let chat = t.chat;
        if (frame.state === 'restarting' && t.state !== 'restarting') {
          chat = [...chat, { kind: 'system', text: `— Session restarted at ${clock()} · conversation kept —` }];
        }
        const praxisKnown = frame.state === 'starting' || frame.state === 'ready' || frame.state === 'busy' || frame.state === 'restarting';
        return {
          ...t,
          state: frame.state,
          reason: frame.state === 'claude-unavailable' ? frame.reason : undefined,
          praxis: praxisKnown ? frame.praxis : t.praxis,
          chat,
        };
      }));
      return;
    }
    case 'assistant-delta': {
      set(mapTab(state, path, (t) => ({ ...t, chat: mapClaude(t.chat, frame.askId, (e) => ({ ...e, text: e.text + frame.text })) })));
      return;
    }
    case 'assistant-tool': {
      set(mapTab(state, path, (t) => ({
        ...t,
        chat: mapClaude(t.chat, frame.askId, (e) => {
          const index = typeof frame.toolIndex === 'number' ? frame.toolIndex : e.tools.length;
          const chip: ToolChip = { index, label: frame.label, state: frame.state };
          const at = e.tools.findIndex((c) => c.index === index);
          const tools = at >= 0 ? e.tools.map((c, i) => (i === at ? chip : c)) : [...e.tools, chip];
          return { ...e, tools };
        }),
      })));
      return;
    }
    case 'assistant-message': {
      set(mapTab(state, path, (t) => ({
        ...t,
        streamingAskId: t.streamingAskId === frame.askId ? null : t.streamingAskId,
        chat: mapClaude(t.chat, frame.askId, (e) => ({
          ...e,
          text: frame.text,
          streaming: false,
          tools: e.tools.length > 0
            ? e.tools.map((c) => (c.state === 'running' ? { ...c, state: 'done' as const } : c))
            : frame.tools.map((label, index) => ({ index, label, state: 'done' as const })),
        })),
      })));
      return;
    }
    case 'assistant-error': {
      set(mapTab(state, path, (t) => {
        const streamingAskId = t.streamingAskId === frame.askId ? null : t.streamingAskId;
        const entry = t.chat.find((e) => e.kind === 'claude' && e.askId === frame.askId) as Extract<ChatEntry, { kind: 'claude' }> | undefined;
        if (!entry) return { ...t, streamingAskId };
        const empty = entry.text.trim() === '' && entry.tools.length === 0;
        if (frame.reason === 'crashed' || frame.reason === 'timeout') {
          const q = t.chat.find((e) => e.kind === 'user' && e.askId === frame.askId) as Extract<ChatEntry, { kind: 'user' }> | undefined;
          const noanswer: ChatEntry = { kind: 'noanswer', askId: frame.askId, question: q?.text ?? '' };
          const chat = empty
            ? t.chat.map((e) => (e.kind === 'claude' && e.askId === frame.askId ? noanswer : e))
            : t.chat.flatMap((e) => (e.kind === 'claude' && e.askId === frame.askId ? [{ ...e, streaming: false }, noanswer] : [e]));
          return { ...t, streamingAskId, chat };
        }
        // budget / claude / limit / session-off / busy: the state frames explain why; keep only real content.
        const chat = empty
          ? t.chat.filter((e) => !(e.kind === 'claude' && e.askId === frame.askId))
          : mapClaude(t.chat, frame.askId, (e) => ({ ...e, streaming: false }));
        return { ...t, streamingAskId, chat };
      }));
      return;
    }
    case 'assistant-task-done': {
      set(mapTab(state, path, (t) => ({ ...t, chat: mapClaude(t.chat, frame.messageId, (e) => ({ ...e, task: { state: 'done', taskId: frame.taskId, direct: frame.direct } })) })));
      return;
    }
    case 'assistant-task-failed': {
      set(mapTab(state, path, (t) => ({ ...t, chat: mapClaude(t.chat, frame.messageId, (e) => ({ ...e, task: { state: 'failed' } })) })));
      return;
    }
    case 'assistant-item': {
      set(mapTab(state, path, (t) => ({ ...t, chat: mapClaude(t.chat, frame.messageId, (e) => ({ ...e, actionState: frame.status === 'created' ? 'added' : 'duplicate' })) })));
      return;
    }
  }
}

// ---------- status ----------

function openCopilotAll(): void {
  if (!transport || state.copilotMode === 'off' || !state.transcript) return; // default off: no copilot frames
  for (const t of state.tabs) transport.copilotOpen(t.projectPath);
}

async function refreshStatus(recheck = false): Promise<void> {
  try {
    const st: AssistantStatus = await fetchAssistantStatus(recheck);
    const becameEnabled = state.enabled !== true && st.session.enabled;
    const copilotWasOff = state.copilotMode === 'off';
    set({
      ...state,
      enabled: st.session.enabled,
      claude: { found: st.claude.found, signedIn: st.claude.signedIn, tooOld: st.claude.tooOld },
      praxisReachable: st.praxis.reachable,
      windowMin: st.session.transcriptWindowMin,
      copilotMode: st.copilot.mode,
      copilotModel: st.copilot.model,
      alwaysBudgetUsd: st.copilot.alwaysBudgetUsd,
      claudeUsable: st.claude.found && st.claude.signedIn && !st.claude.tooOld,
    });
    if (becameEnabled) actions.resync(); // tabs picked before the status arrived are registered now
    else if (copilotWasOff && st.copilot.mode !== 'off') openCopilotAll(); // switched on elsewhere (Settings)
  } catch {
    // status unknown: the column keeps its last state
  }
}

// ---------- actions ----------

function findClaude(askId: string): { tab: AssistantTab; entry: Extract<ChatEntry, { kind: 'claude' }> } | null {
  const tab = activeTab();
  if (!tab) return null;
  const entry = tab.chat.find((e) => e.kind === 'claude' && e.askId === askId) as Extract<ChatEntry, { kind: 'claude' }> | undefined;
  return entry ? { tab, entry } : null;
}

const actions = {
  bind(t: AssistantTransport | null): void {
    transport = t;
  },
  /// Re-registers every open tab on a fresh socket (reconnect, Start Live Text again).
  resync(): void {
    if (!transport) return;
    if (state.enabled === true) for (const t of state.tabs) transport.open(t.projectPath); // default off: no assistant frames while the session is off
    openCopilotAll();
  },
  setLive(live: boolean, transcript = live): void {
    if (state.live === live && state.transcript === transcript) return;
    set({ ...state, live, transcript });
  },
  /// End of the meeting: tabs and chats are per meeting.
  reset(): void {
    transport = null;
    set({ ...state, live: false, transcript: false, tabs: [], active: null, copilot: {}, assistPrefill: null });
  },
  refreshStatus,
  applyFrame,
  applyCopilotFrame,
  openTab(projectPath: string, name?: string): void {
    const key = pathKey(projectPath);
    if (state.tabs.some((t) => pathKey(t.projectPath) === key)) {
      const existing = state.tabs.find((t) => pathKey(t.projectPath) === key)!;
      set({ ...state, active: existing.projectPath });
      return;
    }
    const tab: AssistantTab = { projectPath, name: name || baseName(projectPath), state: 'none', praxis: true, chat: [], streamingAskId: null };
    set({ ...state, tabs: [...state.tabs, tab], active: projectPath });
    if (state.enabled === true) transport?.open(projectPath);
    if (state.copilotMode !== 'off' && state.transcript) transport?.copilotOpen(projectPath);
  },
  closeTab(projectPath: string): void {
    const key = pathKey(projectPath);
    const idx = state.tabs.findIndex((t) => pathKey(t.projectPath) === key);
    if (idx < 0) return;
    transport?.stop(state.tabs[idx].projectPath);
    if (state.copilotMode !== 'off' && state.transcript) transport?.copilotClose(state.tabs[idx].projectPath);
    const tabs = state.tabs.filter((_, i) => i !== idx);
    const wasActive = state.active !== null && pathKey(state.active) === key;
    set({ ...state, tabs, active: wasActive ? (tabs[Math.min(idx, tabs.length - 1)]?.projectPath ?? null) : state.active });
  },
  setActive(projectPath: string): void {
    const tab = state.tabs.find((t) => pathKey(t.projectPath) === pathKey(projectPath));
    if (tab && state.active !== tab.projectPath) set({ ...state, active: tab.projectPath });
  },
  ask(rawText: string): void {
    const tab = activeTab();
    const text = rawText.trim().slice(0, MAX_QUESTION);
    if (!tab || !text || !transport || tab.streamingAskId || inputDisabledReason(state) !== null) return;
    const askId = newId('q');
    const path = tab.projectPath;
    set(mapTab(state, path, (t) => ({
      ...t,
      streamingAskId: askId,
      chat: [
        ...t.chat,
        { kind: 'user', askId, text, windowMin: state.windowMin, transcript: state.transcript },
        { kind: 'claude', askId, text: '', tools: [], streaming: true },
      ],
    })));
    transport.ask(path, text, askId);
  },
  /// "Ask again" on a no-answer row: re-asks that question.
  askAgain(askId: string): void {
    const tab = activeTab();
    const row = tab?.chat.find((e) => e.kind === 'noanswer' && e.askId === askId) as Extract<ChatEntry, { kind: 'noanswer' }> | undefined;
    if (!tab || !row || !row.question) return;
    actions.ask(row.question);
  },
  stop(): void {
    const tab = activeTab();
    if (tab && tab.streamingAskId) transport?.stop(tab.projectPath, true);
  },
  /// Stop session: the child stops, the tab and its conversation stay.
  stopSession(): void {
    const tab = activeTab();
    if (!tab) return;
    const path = tab.projectPath;
    transport?.stop(path);
    set(mapTab(state, path, (t) => ({
      ...t,
      state: 'none',
      reason: undefined,
      streamingAskId: null,
      chat: t.chat
        .map((e) => (e.kind === 'claude' && e.streaming ? { ...e, streaming: false } : e))
        .filter((e) => !(e.kind === 'claude' && e.text.trim() === '' && e.tools.length === 0)),
    })));
    transport?.open(path);
  },
  toAction(askId: string): void {
    const hit = findClaude(askId);
    if (!hit || !transport) return;
    const text = firstParagraphPlain(hit.entry.text);
    if (!text) return;
    transport.addItem(text, 'Me', { projectPath: hit.tab.projectPath, messageId: askId });
  },
  toTask(askId: string): void {
    const hit = findClaude(askId);
    if (!hit || !transport || hit.entry.task?.state === 'creating') return;
    const path = hit.tab.projectPath;
    set(mapTab(state, path, (t) => ({ ...t, chat: mapClaude(t.chat, askId, (e) => ({ ...e, task: { state: 'creating' } })) })));
    transport.task(path, newId('t'), askId);
  },
  copy(askId: string): void {
    const hit = findClaude(askId);
    if (hit) writeClipboard(hit.entry.text).catch(() => {});
  },
  // ---------- AUG-197: copilot ----------
  /// Persists the mode first, then tells the live socket. Resolves to an error message, or null on success.
  async setCopilotMode(mode: CopilotMode, opts: { ack?: boolean } = {}): Promise<string | null> {
    if (mode === 'always' && !opts.ack) return 'Confirm Always-on Claude first.';
    try {
      const st = await postCopilotMode(mode, mode === 'claude' || mode === 'always' ? { accept: true, ack: mode === 'always' } : {});
      const wasOff = state.copilotMode === 'off';
      set({ ...state, copilotMode: st.copilot.mode, copilotModel: st.copilot.model, alwaysBudgetUsd: st.copilot.alwaysBudgetUsd });
      if (state.transcript) transport?.copilotMode(mode);
      if (wasOff && st.copilot.mode !== 'off') openCopilotAll();
      return null;
    } catch (err) {
      return (err as Error).message || 'Something went wrong.';
    }
  },
  async setCopilotModel(model: AiModel): Promise<string | null> {
    try {
      await patchPreferences({ aiCopilotModel: model });
      set({ ...state, copilotModel: model });
      if (state.copilotMode !== 'off' && state.transcript) transport?.copilotMode(undefined, model);
      return null;
    } catch (err) {
      return (err as Error).message || 'Something went wrong.';
    }
  },
  dismissHint(hintId: string, undo = false): void {
    const tab = activeTab();
    if (!tab) return;
    set(mapHint(state, tab.projectPath, hintId, (h) => ({ ...h, dismissed: !undo })));
    transport?.copilotDismiss(tab.projectPath, hintId, undo ? true : undefined);
  },
  undoDismiss(hintId: string): void {
    actions.dismissHint(hintId, true);
  },
  toggleHintLines(hintId: string): void {
    const tab = activeTab();
    if (tab) set(mapHint(state, tab.projectPath, hintId, (h) => ({ ...h, showLines: !h.showLines })));
  },
  /// Open route: loads the TL;DR of the route; a second click hides it.
  openHintRoute(hintId: string): void {
    const tab = activeTab();
    if (!tab) return;
    const path = tab.projectPath;
    const hint = copilotView().hints.find((h) => h.hintId === hintId);
    if (!hint || !hint.route) return;
    if (hint.routeText != null && hint.routeText !== 'loading') {
      set(mapHint(state, path, hintId, (h) => ({ ...h, routeText: null })));
      return;
    }
    if (hint.routeText === 'loading') return;
    set(mapHint(state, path, hintId, (h) => ({ ...h, routeText: 'loading' })));
    fetchCopilotRoute(path, hint.route)
      .then((r) => set(mapHint(state, path, hintId, (h) => ({ ...h, routeText: r.text || 'error' }))))
      .catch(() => set(mapHint(state, path, hintId, (h) => ({ ...h, routeText: 'error' }))));
  },
  /// Ask: prefills the ASSISTANT input and shows that column.
  askAboutHint(hintId: string): void {
    const hint = copilotView().hints.find((h) => h.hintId === hintId);
    if (!hint) return;
    set({ ...state, assistPrefill: { text: hintAskText(hint), nonce: Date.now() } });
    liveColumnsStore.show('as');
  },
};

export const assistantStore = {
  getSnapshot(): AssistantStoreState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  ...actions,
};

export function useAssistantStore(): AssistantStoreState {
  return useSyncExternalStore(assistantStore.subscribe, assistantStore.getSnapshot);
}

// ---------- BroadcastChannel for the compact windows ----------

function lastExchange(tab: AssistantTab | null): CompactExchange | null {
  if (!tab) return null;
  let q = -1;
  for (let i = tab.chat.length - 1; i >= 0; i--) {
    if (tab.chat[i].kind === 'user') { q = i; break; }
  }
  if (q < 0) return null;
  const user = tab.chat[q] as Extract<ChatEntry, { kind: 'user' }>;
  let claude: Extract<ChatEntry, { kind: 'claude' }> | null = null;
  let noAnswer = false;
  for (let i = q + 1; i < tab.chat.length; i++) {
    const e = tab.chat[i];
    if (e.kind === 'claude') claude = e;
    if (e.kind === 'noanswer') noAnswer = true;
  }
  const answer = claude && (claude.text !== '' || claude.tools.length > 0 || claude.streaming)
    ? { text: claude.text, tools: claude.tools.map((c) => c.label), streaming: claude.streaming, actionState: claude.actionState, task: claude.task }
    : null;
  return { askId: user.askId, question: user.text, answer, noAnswer };
}

function copilotSnapshot(s: AssistantStoreState): AssistantSnapshot['copilot'] {
  const cv = copilotView(s);
  const visible = cv.hints.filter((h) => (h.state === 'searching' || h.state === 'found' || h.state === 'explained') && !h.dismissed);
  const hints = visible.slice(0, 3).map((h) => ({
    hintId: h.hintId,
    state: h.state as 'searching' | 'found' | 'explained',
    title: h.route || h.taskId || '',
    text: h.text || h.lines?.[0]?.text || h.title || '',
    clock: h.clock,
  }));
  const newest = visible.find((h) => h.state !== 'searching');
  const st = cv.status?.state;
  return {
    mode: s.copilotMode,
    hintCount: copilotHintCount(s),
    text: newest ? (newest.text || newest.lines?.[0]?.text || newest.title || null) : null,
    hints,
    statusText: st === 'praxis-off' ? 'PraxisOS is not running. Hints are paused; they resume when it starts.'
      : st === 'budget-reached' ? 'Spending limit reached — switched to Claude explains' : null,
    fallbackLocal: st === 'claude-unavailable',
  };
}

export function snapshotForChannel(): AssistantSnapshot {
  const s = state;
  const tab = activeTab(s);
  const view = deriveView(s);
  const exchange = lastExchange(tab); // the answer shares the question's askId; compact windows act on it
  return {
    live: s.live,
    transcript: s.transcript,
    tabs: s.tabs.map((t) => ({
      projectPath: t.projectPath,
      name: t.name,
      mark: t.state === 'starting' || t.state === 'busy' || t.state === 'ready' || t.state === 'restarting' ? 'run'
        : t.state === 'error' || t.state === 'claude-unavailable' || t.state === 'session-off' ? 'err' : 'idle',
    })),
    activeProjectPath: tab?.projectPath ?? null,
    view,
    praxisDown: tab !== null && praxisIsDown(s),
    streaming: tab?.streamingAskId != null,
    inputDisabledReason: inputDisabledReason(s),
    last: exchange,
    copilot: copilotSnapshot(s),
    windowMin: s.windowMin,
  };
}

let channel: BroadcastChannel | null = null;
let publishTimer: ReturnType<typeof setTimeout> | null = null;

function publishNow(): void {
  publishTimer = null;
  try {
    channel?.postMessage({ type: 'state', state: snapshotForChannel() } satisfies AssistantChannelMessage);
  } catch {
    // channel closed
  }
}

function schedulePublish(): void {
  if (!channel || publishTimer) return;
  publishTimer = setTimeout(publishNow, 60);
}

function handleChannel(msg: AssistantChannelMessage): void {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') { publishNow(); return; }
  if (msg.type !== 'action') return;
  const a = msg.action;
  switch (a.kind) {
    case 'ask': actions.ask(a.text); break;
    case 'stop': actions.stop(); break;
    case 'set-active': actions.setActive(a.projectPath); break;
    case 'to-action': actions.toAction(a.askId); break;
    case 'to-task': actions.toTask(a.askId); break;
    case 'copy': actions.copy(a.askId); break;
    case 'copilot-dismiss': actions.dismissHint(a.hintId); break;
    case 'copilot-ask': {
      const hint = copilotView().hints.find((h) => h.hintId === a.hintId);
      if (hint && inputDisabledReason(state) === null) actions.ask(hintAskText(hint));
      else {
        compactStore.requestExpand();
        actions.askAboutHint(a.hintId);
      }
      break;
    }
    case 'show-copilot':
      compactStore.requestExpand();
      liveColumnsStore.show('cp');
      break;
  }
}

if (typeof BroadcastChannel !== 'undefined' && typeof window !== 'undefined') {
  try {
    channel = new BroadcastChannel(ASSISTANT_CHANNEL);
    channel.onmessage = (e: MessageEvent<AssistantChannelMessage>) => handleChannel(e.data);
  } catch {
    channel = null;
  }
}
