import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { acquireChildSlot, releaseChildSlot } from './aiChildPool.js';
import { buildAssistantStatus, isClaudeUsable, probePraxisReachable, type CopilotMode } from './assistantState.js';
import { getClaudeProbe, getResolvedClaudeCli } from './claudeCli.js';
import { COPILOT_ALLOWED_TOOLS, ClaudeTransport, buildCopilotArgs, notePraxisToolsFromInit, type TransportEvent } from './claudeTransport.js';
import {
  ALWAYS_PROMPT,
  COPILOT_PROMPT,
  CopilotLimiter,
  buildBatchMessage,
  buildExplainMessage,
  buildHintSummary,
  buildKeywords,
  buildLexicon,
  gateFire,
  parseCopilotAnswer,
  parseSearchResult,
  parseTaskResult,
  routeFromPath,
  type SearchBlock,
  type TaskHit,
} from './copilotGate.js';
import { getLiveFeed, type FeedLine, type LiveFeed } from './liveFeed.js';
import type { LiveControlFrame } from './liveChunking.js';
import { PraxisDownError, praxisMcp } from './praxisMcpClient.js';
import { validatePraxisProject } from './praxisIntegration.js';
import { readPreferences, type AiModel } from './preferencesStore.js';

/// AUG-197: the Meeting Copilot engine — per (liveKey, project) tab: the gate on every transcript line, a local Praxis search and,
/// in the Claude modes, a small `claude -p` child that explains the match. Always-on batches the transcript instead of gating.
/// Logs carry counts, timings, verdicts and costs only: never transcript text, keywords, hint text or answers.

type Send = (payload: unknown) => void;
export type CopilotFrame = Extract<LiveControlFrame, { type: 'copilot-open' | 'copilot-close' | 'copilot-dismiss' | 'copilot-mode' }>;

export interface CopilotSocketHandle {
  handleFrame(frame: CopilotFrame): void;
  detach(): void;
}

type EffMode = CopilotMode;
type StatusState = 'ok' | 'praxis-off' | 'claude-unavailable' | 'budget-reached' | 'limit' | 'paused';
type HintState = 'searching' | 'found' | 'explained' | 'removed';
type HintNote = 'claude-off' | 'claude-unavailable' | 'local';

const SOCKET_GRACE_MS = 60_000;
const CHILD_IDLE_MS = 10 * 60_000;
const CLAUDE_CONTEXT_WAIT_MS = 4_000;
const SEARCH_TIMEOUT_MS = 2_000;
const PRAXIS_RETRY_MS = 30_000;
const ALWAYS_TICK_MS = 30_000;
const ALWAYS_MIN_WORDS = 40;
const ALWAYS_BATCH_TIMEOUT_MS = 30_000;
const ALWAYS_MAX_TURNS = 30;
const ALWAYS_MAX_PENDING = 200;
const MAX_HINTS = 200;
const LATE_RESULT_GUARD_MS = 60_000;

const short = (liveKey: string) => liveKey.slice(0, 8);
const tabKey = (liveKey: string, projectPath: string) => `${liveKey}:${path.resolve(projectPath).toLowerCase()}`;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function clockOf(feed: LiveFeed, at: number): string {
  const s = Math.max(0, Math.floor((at - feed.startedAt) / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ---------------------------------------------------------------------------
// The Claude child

interface AskResult {
  status: 'ok' | 'timeout' | 'error' | 'busy' | 'unavailable' | 'limit' | 'budget';
  text?: string;
  costDelta: number;
  ms: number;
}

interface ChildOptions {
  id: string;
  root: string;
  getModel: () => string;
  getBudget: () => number | null;
  systemPrompt: () => string;
  onCost: (delta: number) => void;
}

interface PendingTurn {
  resolve: (r: AskResult) => void;
  text: string;
  timer: NodeJS.Timeout;
  startedAt: number;
  cost: number;
}

/// One persistent `claude -p` stream-json child, one turn at a time, started lazily and stopped after 10 idle minutes.
class CopilotChild {
  private t: ClaudeTransport | null = null;
  private turn: PendingTurn | null = null;
  private late = 0; // turns that timed out but have not delivered their result yet
  private prevCost = 0;
  private lastUsedAt = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private lateTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: ChildOptions) {}

  get alive(): boolean {
    return !!this.t && this.t.alive;
  }

  get pid(): number | null {
    return this.t?.pid ?? null;
  }

  get busy(): boolean {
    return this.turn !== null || this.late > 0;
  }

  private spawn(): 'ok' | 'unavailable' | 'limit' {
    const cli = getResolvedClaudeCli();
    if (!cli || cli.shim) return 'unavailable';
    const ok = acquireChildSlot({
      id: this.o.id,
      kind: 'copilot',
      busy: () => this.busy,
      lastUsedAt: () => this.lastUsedAt,
      evict: () => {
        void this.stop();
      },
    });
    if (!ok) return 'limit';
    const args = buildCopilotArgs({ model: this.o.getModel(), sessionId: randomUUID(), maxBudgetUsd: this.o.getBudget(), systemPrompt: this.o.systemPrompt() });
    const t = new ClaudeTransport();
    this.t = t;
    this.prevCost = 0;
    this.late = 0;
    const live = () => this.t === t;
    t.on('init', (ev: Extract<TransportEvent, { type: 'init' }>) => {
      if (live()) notePraxisToolsFromInit(ev.tools);
    });
    t.on('delta', (ev: Extract<TransportEvent, { type: 'delta' }>) => {
      if (live() && this.turn) this.turn.text += ev.text;
    });
    t.on('result', (ev: Extract<TransportEvent, { type: 'result' }>) => {
      if (!live()) return;
      let delta = 0;
      if (ev.totalCostUsd !== null) {
        delta = Math.max(0, ev.totalCostUsd - this.prevCost);
        this.prevCost = ev.totalCostUsd;
        if (delta > 0) this.o.onCost(delta);
      }
      this.lastUsedAt = Date.now();
      this.armIdle();
      if (this.late > 0 && !this.turn) {
        this.late--; // a timed-out turn finally answered: cost counted, answer dropped
        if (this.late === 0 && this.lateTimer) clearTimeout(this.lateTimer);
        return;
      }
      const turn = this.turn;
      if (!turn) return;
      this.turn = null;
      clearTimeout(turn.timer);
      turn.cost += delta;
      const ms = Date.now() - turn.startedAt;
      if (ev.subtype === 'error_max_budget_usd') {
        turn.resolve({ status: 'budget', costDelta: turn.cost, ms });
        void this.stop();
      } else if (ev.isError) {
        turn.resolve({ status: 'error', costDelta: turn.cost, ms });
      } else {
        turn.resolve({ status: 'ok', text: ev.text || turn.text, costDelta: turn.cost, ms });
      }
    });
    t.on('exit', () => {
      if (!live()) return;
      this.t = null;
      releaseChildSlot(this.o.id);
      this.clearTimers();
      this.late = 0;
      const turn = this.turn;
      if (turn) {
        this.turn = null;
        clearTimeout(turn.timer);
        turn.resolve({ status: 'error', costDelta: turn.cost, ms: Date.now() - turn.startedAt });
      }
    });
    t.start({ cli, args, cwd: this.o.root });
    this.armIdle();
    return 'ok';
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.busy) void this.stop();
    }, CHILD_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.lateTimer) clearTimeout(this.lateTimer);
    this.idleTimer = null;
    this.lateTimer = null;
  }

  async ask(text: string, timeoutMs: number): Promise<AskResult> {
    const t0 = Date.now();
    if (this.busy) return { status: 'busy', costDelta: 0, ms: 0 };
    if (!this.alive) {
      const s = this.spawn();
      if (s !== 'ok') return { status: s, costDelta: 0, ms: Date.now() - t0 };
    }
    const t = this.t;
    if (!t || !t.send(text)) {
      void this.stop();
      return { status: 'error', costDelta: 0, ms: Date.now() - t0 };
    }
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return new Promise<AskResult>((resolve) => {
      const turn: PendingTurn = {
        resolve,
        text: '',
        startedAt: Date.now(),
        cost: 0,
        timer: setTimeout(() => {
          if (this.turn !== turn) return;
          this.turn = null;
          this.late++;
          this.lateTimer = setTimeout(() => {
            this.lateTimer = null;
            if (this.late > 0) void this.stop(); // never answered: drop the child
          }, LATE_RESULT_GUARD_MS);
          this.lateTimer.unref?.();
          resolve({ status: 'timeout', costDelta: turn.cost, ms: Date.now() - turn.startedAt });
        }, timeoutMs),
      };
      turn.timer.unref?.();
      this.turn = turn;
    });
  }

  /// Graceful stop (win32: stdin end, then taskkill /T /F after 5 s; elsewhere SIGTERM then SIGKILL); frees the pool slot at once.
  stop(): Promise<void> {
    const t = this.t;
    this.t = null;
    this.late = 0;
    this.clearTimers();
    releaseChildSlot(this.o.id);
    const turn = this.turn;
    if (turn) {
      this.turn = null;
      clearTimeout(turn.timer);
      turn.resolve({ status: 'error', costDelta: turn.cost, ms: Date.now() - turn.startedAt });
    }
    return t ? t.stop() : Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Hub / engine state

interface Cfg {
  savedMode: CopilotMode;
  model: AiModel;
  alwaysBudgetUsd: number;
  consentStale: boolean;
  claudeUsable: boolean;
}

interface HintRec {
  route?: string;
  taskId?: string;
}

interface AlwaysState {
  child: CopilotChild;
  pending: FeedLine[];
  timer: NodeJS.Timeout;
  turns: number;
  busy: boolean;
  shown: Array<{ source: string; text: string }>;
}

interface Engine {
  key: string;
  projectPath: string; // as the client sent it; echoed in every frame
  root: string;
  limiter: CopilotLimiter;
  suppressed: Set<string>;
  hints: Map<string, HintRec>;
  counts: { shown: number; silent: number; dismissed: number };
  explain: CopilotChild;
  always: AlwaysState | null;
  lexicon: Promise<string[]>;
  limit: boolean;
  closed: boolean;
  lastSig: string;
}

interface Hub {
  liveKey: string;
  sockets: Set<Send>;
  engines: Map<string, Engine>;
  cfg: Cfg | null;
  meetingOverride: 'claude' | 'off' | 'local' | null;
  budgetReached: boolean;
  alwaysSpent: number;
  claudeBroken: boolean;
  praxisOk: boolean;
  praxisRetry: NodeJS.Timeout | null;
  feed: LiveFeed | null;
  unsubscribeFeed: (() => void) | null;
  graceTimer: NodeJS.Timeout | null;
  closed: boolean;
}

const hubs = new Map<string, Hub>();

function broadcast(hub: Hub, payload: unknown): void {
  for (const send of hub.sockets) {
    try {
      send(payload);
    } catch {
      // a dead socket is removed by its own close handler
    }
  }
}

async function loadCfg(): Promise<Cfg> {
  const prefs = await readPreferences();
  const probe = await getClaudeProbe();
  const c = buildAssistantStatus(prefs, probe, true).copilot;
  return { savedMode: c.mode, model: c.model, alwaysBudgetUsd: c.alwaysBudgetUsd, consentStale: c.consentStale, claudeUsable: isClaudeUsable(probe) };
}

function effective(hub: Hub, eng?: Engine): { mode: EffMode; state: StatusState } {
  const cfg = hub.cfg;
  const base: EffMode = hub.meetingOverride ?? cfg?.savedMode ?? 'off';
  if (!cfg || base === 'off') return { mode: 'off', state: 'paused' };
  let mode: EffMode = base;
  let state: StatusState = 'ok';
  if ((base === 'claude' || base === 'always') && (cfg.consentStale || !cfg.claudeUsable || hub.claudeBroken)) {
    mode = 'local';
    state = 'claude-unavailable';
  } else if (hub.budgetReached) {
    mode = 'claude';
    state = 'budget-reached';
  } else if (eng?.limit && (base === 'claude' || base === 'always')) {
    state = 'limit';
  }
  if (!hub.praxisOk) state = 'praxis-off';
  return { mode, state };
}

function statusFrame(hub: Hub, projectPath: string, counts: Engine['counts'], eng?: Engine) {
  const eff = effective(hub, eng);
  return {
    type: 'copilot-status',
    projectPath,
    mode: eff.mode,
    savedMode: hub.cfg?.savedMode ?? 'off',
    model: hub.cfg?.model ?? 'sonnet',
    state: eff.state,
    counts: { ...counts },
  };
}

function sendStatus(hub: Hub, eng: Engine, force = false): void {
  const frame = statusFrame(hub, eng.projectPath, eng.counts, eng);
  const sig = JSON.stringify(frame);
  if (!force && sig === eng.lastSig) return;
  eng.lastSig = sig;
  broadcast(hub, frame);
}

function sendAllStatus(hub: Hub, force = false): void {
  for (const eng of hub.engines.values()) sendStatus(hub, eng, force);
}

function emitHint(
  hub: Hub,
  eng: Engine,
  hint: { hintId: string; at: number; clock: string; state: HintState } & Partial<{
    route: string;
    taskId: string;
    title: string;
    lines: Array<{ n: number; text: string }>;
    text: string;
    source: string;
    note: HintNote;
  }>,
): void {
  if (eng.closed || hub.closed) return;
  if (hint.state === 'removed') {
    eng.hints.delete(hint.hintId);
  } else {
    const prev = eng.hints.get(hint.hintId) ?? {};
    eng.hints.set(hint.hintId, { route: hint.route ?? prev.route, taskId: hint.taskId ?? prev.taskId });
    while (eng.hints.size > MAX_HINTS) {
      const oldest = eng.hints.keys().next().value;
      if (oldest === undefined) break;
      eng.hints.delete(oldest);
    }
  }
  broadcast(hub, { type: 'copilot-hint', projectPath: eng.projectPath, ...hint });
}

const newHintId = () => randomUUID().replace(/-/g, '').slice(0, 16);

// ---------------------------------------------------------------------------
// Praxis health

function markPraxisDown(hub: Hub): void {
  praxisMcp.reset();
  if (!hub.praxisOk || hub.closed) return;
  hub.praxisOk = false;
  sendAllStatus(hub);
  if (hub.praxisRetry) return;
  hub.praxisRetry = setInterval(() => {
    void probePraxisReachable().then((ok) => {
      if (!ok || hub.closed || hub.praxisOk) return;
      hub.praxisOk = true;
      if (hub.praxisRetry) clearInterval(hub.praxisRetry);
      hub.praxisRetry = null;
      sendAllStatus(hub);
    });
  }, PRAXIS_RETRY_MS);
  hub.praxisRetry.unref?.();
}

/// A fetch failure may also be a slow call; only a failed health probe turns the copilot off.
async function confirmPraxisDown(hub: Hub): Promise<void> {
  if (!(await probePraxisReachable())) markPraxisDown(hub);
}

async function praxisCall(hub: Hub, name: (typeof COPILOT_ALLOWED_TOOLS)[number], args: Record<string, unknown>): Promise<string | null> {
  try {
    return await withTimeout(praxisMcp.callTool(name, args, SEARCH_TIMEOUT_MS), SEARCH_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof PraxisDownError) await confirmPraxisDown(hub);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Feed

function ensureFeed(hub: Hub): void {
  if (hub.unsubscribeFeed || hub.closed) return;
  const feed = getLiveFeed(hub.liveKey);
  if (!feed) return;
  hub.feed = feed;
  hub.unsubscribeFeed = feed.subscribe((line, kind) => {
    if (kind !== 'push') return;
    for (const eng of hub.engines.values()) onLine(hub, eng, line);
  });
}

function onLine(hub: Hub, eng: Engine, line: FeedLine): void {
  if (eng.closed || hub.closed) return;
  try {
    const eff = effective(hub, eng);
    if (eff.mode === 'off') return;
    if (eff.mode === 'always' && eng.always) {
      eng.always.pending.push(line);
      if (eng.always.pending.length > ALWAYS_MAX_PENDING) eng.always.pending.splice(0, eng.always.pending.length - ALWAYS_MAX_PENDING);
      return;
    }
    void runCheck(hub, eng, line).catch((err) => console.warn(`[copilot] key=${short(hub.liveKey)} check failed: ${(err as Error).name}`));
  } catch (err) {
    console.warn(`[copilot] key=${short(hub.liveKey)} line failed: ${(err as Error).name}`);
  }
}

// ---------------------------------------------------------------------------
// Local check (modes local / claude)

const TASK_SOURCE_RE = /\b[A-Z][A-Z0-9]{1,5}-\d+\b/;
const ROUTE_SOURCE_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function normalizeRoute(source: string): string | null {
  const s = source.trim().replace(/\\/g, '/');
  const r = routeFromPath(s.endsWith('.md') ? s : s.replace(/\/+$/, ''));
  return ROUTE_SOURCE_RE.test(r) && !TASK_SOURCE_RE.test(r) ? r : null;
}

function claudeCandidates(exact: SearchBlock | null, task: TaskHit | null, partials: SearchBlock[]): string[] {
  const out: string[] = [];
  if (exact) {
    for (const l of exact.lines.slice(0, 2)) out.push(`project-context/${exact.route}/README.md L${l.n}: ${l.text}`);
  }
  if (task) out.push(`${task.shortId}: ${task.title}`);
  for (const p of partials) out.push(`project-context/${p.route}/README.md L${p.lines[0].n}: ${p.lines[0].text}`);
  return out.slice(0, 3);
}

function logCheck(
  hub: Hub,
  eng: Engine,
  o: { rule: string; searchMs: number; local: string; claudeMs: number | null; verdict: string; cost: number | null },
): void {
  console.log(
    `[copilot] key=${short(hub.liveKey)} project=${path.basename(eng.root)} fire=${o.rule} search=${o.searchMs} local=${o.local} claude=${o.claudeMs === null ? '-' : o.claudeMs} verdict=${o.verdict} cost=${o.cost === null ? '-' : o.cost.toFixed(4)} shown=${eng.counts.shown} silent=${eng.counts.silent}`,
  );
}

async function runCheck(hub: Hub, eng: Engine, line: FeedLine): Promise<void> {
  const feed = hub.feed;
  if (!feed) return;
  const fire = gateFire(line.text);
  if (!fire) return;
  if (!hub.praxisOk) return;
  const now = Date.now();
  if (!eng.limiter.canSearch(now)) return;
  eng.limiter.markSearch(now);

  const eff = effective(hub, eng);
  const snap = feed.snapshot(60_000);
  const idx = snap.findIndex((l) => l.id === line.id);
  const ctx = idx >= 0 ? snap.slice(Math.max(0, idx - 2), idx + 1) : [line];
  const lexicon = await eng.lexicon.catch(() => [] as string[]);
  const kws = buildKeywords(ctx.map((l) => l.text), lexicon);
  if (kws.length === 0) {
    eng.counts.silent++;
    sendStatus(hub, eng);
    logCheck(hub, eng, { rule: fire.rule, searchMs: 0, local: 'none', claudeMs: null, verdict: '-', cost: null });
    return;
  }

  const t0 = Date.now();
  const [searchText, taskText] = await Promise.all([
    praxisCall(hub, 'search_project_context', { project_root: eng.root, query: kws.join(' ') }),
    praxisCall(hub, 'find_task_by_keywords', { project_root: eng.root, query: kws[0] }),
  ]);
  const searchMs = Date.now() - t0;
  if (eng.closed || hub.closed) return;

  const blocks = searchText ? parseSearchResult(searchText) : [];
  const tasks = taskText ? parseTaskResult(taskText) : [];
  const at = Date.now();
  const exactTop = blocks.find((b) => b.kind === 'exact' && b.lines.length > 0) ?? null;
  const exact =
    exactTop &&
    !eng.suppressed.has(`r:${exactTop.route}`) &&
    eng.limiter.routeAllowed(`r:${exactTop.route}`, at) &&
    !eng.limiter.isDuplicate(`${exactTop.route}:${exactTop.lines[0].n}`)
      ? exactTop
      : null;
  const task = tasks.find((t) => !eng.suppressed.has(`t:${t.shortId}`) && eng.limiter.routeAllowed(`t:${t.shortId}`, at)) ?? null;
  const partials = blocks.filter((b) => b.kind === 'partial' && b.lines.length >= 2 && !eng.suppressed.has(`r:${b.route}`));
  const local = exact ? 'exact' : task ? 'task' : partials.length > 0 ? 'partial' : 'none';
  const hit = !!(exact || task);

  const base = { at: line.at, clock: clockOf(feed, line.at) };
  const localCard = () => ({
    ...(exact ? { route: exact.route, lines: exact.lines.slice(0, 2) } : {}),
    ...(task ? { taskId: task.shortId, title: task.title } : {}),
  });
  const markShown = (route?: string, taskId?: string, lineN?: number) => {
    const t = Date.now();
    if (route) {
      eng.limiter.markShown(`r:${route}`, t);
      if (lineN !== undefined) eng.limiter.markLine(`${route}:${lineN}`);
    }
    if (taskId) eng.limiter.markShown(`t:${taskId}`, t);
    eng.counts.shown++;
  };
  const showFound = (hintId: string, note?: HintNote) => {
    emitHint(hub, eng, { hintId, ...base, state: 'found', ...localCard(), ...(note ? { note } : {}) });
    markShown(exact?.route, task?.shortId, exact?.lines[0].n);
  };
  const finish = (verdict: string, claudeMs: number | null, cost: number | null) => {
    sendStatus(hub, eng);
    logCheck(hub, eng, { rule: fire.rule, searchMs, local, claudeMs, verdict, cost });
  };

  // Local hints (also the fallback when Claude cannot run).
  const plainNote: HintNote | undefined =
    eff.state === 'claude-unavailable'
      ? 'claude-unavailable'
      : hub.meetingOverride === 'local' && (hub.cfg?.savedMode === 'claude' || hub.cfg?.savedMode === 'always')
        ? 'claude-off'
        : 'local';
  if (eff.mode !== 'claude') {
    if (hit) showFound(newHintId(), plainNote);
    else eng.counts.silent++;
    finish('-', null, null);
    return;
  }

  // Claude explains.
  if (!eng.limiter.canClaude(Date.now())) {
    if (hit) showFound(newHintId());
    else eng.counts.silent++;
    finish('-', null, null);
    return;
  }
  const hintId = newHintId();
  emitHint(hub, eng, { hintId, ...base, state: 'searching' });
  await delay(CLAUDE_CONTEXT_WAIT_MS);
  if (eng.closed || hub.closed) return;
  const triggerLines = feed.around(line.id, { before: 1, afterMs: 8_000, maxWords: 80 }).map((l) => `[${l.speaker}] ${l.text}`);
  const cands = claudeCandidates(exact, task, partials);
  eng.limiter.markClaude(Date.now());
  const res = await eng.explain.ask(buildExplainMessage(triggerLines, cands), cands.length > 0 ? 6_000 : 12_000);
  if (eng.closed || hub.closed) return;
  if (res.status === 'ok' || res.status === 'timeout') eng.limit = false;
  if (res.status === 'limit') eng.limit = true;
  if (res.status === 'unavailable') hub.claudeBroken = true;

  const answer = res.status === 'ok' && res.text ? parseCopilotAnswer(res.text) : null;
  if (answer?.verdict === 'match') {
    const task2 = TASK_SOURCE_RE.exec(answer.source)?.[0];
    const route2 = task2 ? undefined : normalizeRoute(answer.source) ?? undefined;
    const block = route2 ? blocks.find((b) => b.route === route2) : undefined;
    const taskHit = task2 ? tasks.find((t) => t.shortId === task2) : undefined;
    const route = route2 ?? (!task2 ? exact?.route : undefined);
    const lines = (block ?? (route && route === exact?.route ? exact : undefined))?.lines.slice(0, 2);
    emitHint(hub, eng, {
      hintId,
      ...base,
      state: 'explained',
      text: answer.text,
      source: answer.source,
      ...(route ? { route } : {}),
      ...(task2 ? { taskId: task2, ...(taskHit ? { title: taskHit.title } : {}) } : {}),
      ...(lines && lines.length > 0 ? { lines } : {}),
    });
    markShown(route, task2, lines?.[0]?.n);
    finish('match', res.ms, res.costDelta);
    return;
  }
  if (answer?.verdict === 'none') {
    emitHint(hub, eng, { hintId, ...base, state: 'removed' });
    eng.counts.silent++;
    finish('none', res.ms, res.costDelta);
    return;
  }
  const verdict = res.status === 'timeout' ? 'timeout' : 'error';
  if (hit) {
    showFound(hintId, res.status === 'unavailable' || res.status === 'limit' ? 'claude-unavailable' : undefined);
  } else {
    emitHint(hub, eng, { hintId, ...base, state: 'removed' });
    eng.counts.silent++;
  }
  finish(verdict, res.ms, res.costDelta);
}

// ---------------------------------------------------------------------------
// Always-on

function newChild(hub: Hub, eng: Engine, always: boolean): CopilotChild {
  return new CopilotChild({
    id: `copilot:${eng.key}${always ? ':always' : ''}`,
    root: eng.root,
    getModel: () => hub.cfg?.model ?? 'sonnet',
    getBudget: () => {
      if (!always) return null;
      const limit = hub.cfg?.alwaysBudgetUsd ?? 0;
      return limit > 0 ? Math.max(0.01, limit - hub.alwaysSpent) : null;
    },
    systemPrompt: () => (always ? ALWAYS_PROMPT(eng.root) : COPILOT_PROMPT(eng.root)),
    onCost: (delta) => {
      if (always) hub.alwaysSpent += delta;
    },
  });
}

function startAlways(hub: Hub, eng: Engine): void {
  if (eng.always || eng.closed) return;
  const a: AlwaysState = {
    child: newChild(hub, eng, true),
    pending: [],
    turns: 0,
    busy: false,
    shown: [],
    timer: setInterval(() => {
      void alwaysTick(hub, eng).catch((err) => console.warn(`[copilot] key=${short(hub.liveKey)} always tick failed: ${(err as Error).name}`));
    }, ALWAYS_TICK_MS),
  };
  a.timer.unref?.();
  eng.always = a;
}

function stopAlways(eng: Engine): Promise<void> {
  const a = eng.always;
  if (!a) return Promise.resolve();
  eng.always = null;
  clearInterval(a.timer);
  return a.child.stop();
}

function budgetExhausted(hub: Hub): boolean {
  const limit = hub.cfg?.alwaysBudgetUsd ?? 0;
  return limit > 0 && hub.alwaysSpent >= limit;
}

/// Always-on hit its limit: this meeting continues as Claude explains and never resumes always-on by itself.
function handleBudget(hub: Hub): void {
  if (hub.budgetReached) return;
  hub.budgetReached = true;
  hub.meetingOverride = 'claude';
  for (const eng of hub.engines.values()) void stopAlways(eng);
  sendAllStatus(hub);
}

async function alwaysTick(hub: Hub, eng: Engine): Promise<void> {
  const a = eng.always;
  const feed = hub.feed;
  if (!a || !feed || a.busy || eng.closed || hub.closed || !hub.praxisOk) return;
  if (effective(hub, eng).mode !== 'always') return;
  const words = a.pending.reduce((n, l) => n + wordCount(l.text), 0);
  if (words < ALWAYS_MIN_WORDS) return;
  const lines = a.pending.splice(0);
  a.busy = true;
  try {
    if (a.turns >= ALWAYS_MAX_TURNS) {
      await a.child.stop();
      a.turns = 0;
    }
    const summary = !a.child.alive && a.shown.length > 0 ? buildHintSummary(a.shown) : undefined;
    const last = lines[lines.length - 1];
    const res = await a.child.ask(buildBatchMessage(lines.map((l) => feed.formatLine(l)), summary), ALWAYS_BATCH_TIMEOUT_MS);
    if (eng.closed || hub.closed || eng.always !== a) return;
    if (res.status !== 'busy') a.turns++;
    if (res.status === 'ok' || res.status === 'timeout') eng.limit = false;
    if (res.status === 'limit') eng.limit = true;
    if (res.status === 'unavailable') hub.claudeBroken = true;
    let verdict = '-';
    if (res.status === 'budget' || budgetExhausted(hub)) {
      verdict = 'budget';
      handleBudget(hub);
    } else if (res.status === 'ok' && res.text) {
      const answer = parseCopilotAnswer(res.text);
      verdict = answer ? answer.verdict : 'error';
      if (answer?.verdict === 'match') showAlwaysMatch(hub, eng, a, feed, last, answer.text, answer.source);
    } else {
      verdict = res.status === 'timeout' ? 'timeout' : 'error';
    }
    console.log(
      `[copilot] key=${short(hub.liveKey)} project=${path.basename(eng.root)} fire=always search=0 local=none claude=${res.ms} verdict=${verdict} cost=${res.costDelta.toFixed(4)} shown=${eng.counts.shown} silent=${eng.counts.silent}`,
    );
    if (verdict === 'none') eng.counts.silent++;
    sendAllStatus(hub);
  } finally {
    a.busy = false;
  }
}

function showAlwaysMatch(hub: Hub, eng: Engine, a: AlwaysState, feed: LiveFeed, last: FeedLine, text: string, source: string): void {
  const task = TASK_SOURCE_RE.exec(source)?.[0];
  const route = task ? undefined : normalizeRoute(source) ?? undefined;
  const key = task ? `t:${task}` : route ? `r:${route}` : `s:${source}`;
  const now = Date.now();
  if (eng.suppressed.has(key) || !eng.limiter.routeAllowed(key, now) || eng.limiter.isDuplicate(`${key}:${text}`)) {
    eng.counts.silent++;
    return;
  }
  emitHint(hub, eng, {
    hintId: newHintId(),
    at: last.at,
    clock: clockOf(feed, last.at),
    state: 'explained',
    text,
    source,
    ...(route ? { route } : {}),
    ...(task ? { taskId: task } : {}),
  });
  eng.limiter.markShown(key, now);
  eng.limiter.markLine(`${key}:${text}`);
  eng.counts.shown++;
  a.shown.push({ source, text });
  if (a.shown.length > 20) a.shown.shift();
}

// ---------------------------------------------------------------------------
// Frames

function stopEngine(eng: Engine): Promise<void> {
  eng.closed = true;
  return Promise.all([eng.explain.stop(), stopAlways(eng)]).then(() => undefined);
}

/// Brings every engine in line with the effective mode: always timers and children, explain child.
function applyModes(hub: Hub): void {
  const eff = effective(hub);
  for (const eng of hub.engines.values()) {
    if (eng.closed) continue;
    if (eff.mode === 'always') startAlways(hub, eng);
    else void stopAlways(eng);
    if (eff.mode === 'off' || eff.mode === 'local') void eng.explain.stop();
  }
  sendAllStatus(hub);
}

async function openEngine(hub: Hub, projectPath: string): Promise<void> {
  const key = tabKey(hub.liveKey, projectPath);
  const existing = hub.engines.get(key);
  if (existing) {
    sendStatus(hub, existing, true);
    return;
  }
  hub.cfg = await loadCfg();
  hub.claudeBroken = false;
  const paused = () => broadcast(hub, { ...statusFrame(hub, projectPath, { shown: 0, silent: 0, dismissed: 0 }), mode: 'off', state: 'paused' });
  if (effective(hub).mode === 'off') return paused();
  const root = path.resolve(projectPath);
  if (!(await validatePraxisProject(root))) return paused();
  if (hub.closed) return;
  const raced = hub.engines.get(key);
  if (raced) {
    sendStatus(hub, raced, true);
    return;
  }
  const eng: Engine = {
    key,
    projectPath,
    root,
    limiter: new CopilotLimiter(),
    suppressed: new Set(),
    hints: new Map(),
    counts: { shown: 0, silent: 0, dismissed: 0 },
    explain: null as unknown as CopilotChild,
    always: null,
    lexicon: buildLexicon(root).catch(() => [] as string[]),
    limit: false,
    closed: false,
    lastSig: '',
  };
  eng.explain = newChild(hub, eng, false);
  hub.engines.set(key, eng);
  ensureFeed(hub);
  if (effective(hub).mode === 'always') startAlways(hub, eng);
  sendStatus(hub, eng, true);
}

function closeEngine(hub: Hub, projectPath: string): void {
  const key = tabKey(hub.liveKey, projectPath);
  const eng = hub.engines.get(key);
  if (!eng) return;
  hub.engines.delete(key);
  void stopEngine(eng);
}

function handleDismiss(hub: Hub, frame: Extract<CopilotFrame, { type: 'copilot-dismiss' }>): void {
  const eng = hub.engines.get(tabKey(hub.liveKey, frame.projectPath));
  const rec = eng?.hints.get(frame.hintId);
  if (!eng || !rec) return;
  const keys = [rec.route ? `r:${rec.route}` : null, rec.taskId ? `t:${rec.taskId}` : null].filter((k): k is string => !!k);
  if (frame.undo) {
    for (const k of keys) eng.suppressed.delete(k);
    eng.counts.dismissed = Math.max(0, eng.counts.dismissed - 1);
  } else {
    for (const k of keys) eng.suppressed.add(k);
    eng.counts.dismissed++;
  }
  sendStatus(hub, eng);
}

async function handleMode(hub: Hub, frame: Extract<CopilotFrame, { type: 'copilot-mode' }>): Promise<void> {
  const prevModel = hub.cfg?.model;
  hub.claudeBroken = false;
  hub.cfg = await loadCfg();
  const saved = hub.cfg.savedMode;
  if (frame.mode) {
    if (frame.mode === saved) {
      // The spend is per meeting and never reset: re-picking Always-on resumes it only when the limit (re-read above) leaves room.
      if (!(frame.mode === 'always' && budgetExhausted(hub))) {
        hub.meetingOverride = null;
        hub.budgetReached = false;
      }
    } else if (frame.mode === 'off' || frame.mode === 'local') {
      hub.meetingOverride = frame.mode;
      hub.budgetReached = false;
    }
    // a claude / always frame that differs from the saved mode is ignored: consent comes from preferences only
  }
  if (prevModel && prevModel !== hub.cfg.model) {
    for (const eng of hub.engines.values()) {
      void eng.explain.stop();
      void eng.always?.child.stop();
    }
  }
  ensureFeed(hub);
  applyModes(hub);
}

// ---------------------------------------------------------------------------
// Socket lifecycle

export function attachCopilotSocket(liveKey: string, send: Send): CopilotSocketHandle {
  let hub = hubs.get(liveKey);
  if (!hub) {
    const created: Hub = {
      liveKey,
      sockets: new Set(),
      engines: new Map(),
      cfg: null,
      meetingOverride: null,
      budgetReached: false,
      alwaysSpent: 0,
      claudeBroken: false,
      praxisOk: true,
      praxisRetry: null,
      feed: null,
      unsubscribeFeed: null,
      graceTimer: null,
      closed: false,
    };
    hubs.set(liveKey, created);
    hub = created;
    void probePraxisReachable().then((ok) => {
      if (!ok && !created.closed) markPraxisDown(created);
    });
  }
  const h = hub;
  if (h.graceTimer) clearTimeout(h.graceTimer);
  h.graceTimer = null;
  h.sockets.add(send);
  for (const eng of h.engines.values()) send(statusFrame(h, eng.projectPath, eng.counts, eng)); // reconnect: replay current state

  return {
    handleFrame(frame) {
      if (hubs.get(liveKey) !== h) return; // the meeting ended
      const run = async () => {
        switch (frame.type) {
          case 'copilot-open':
            await openEngine(h, frame.projectPath);
            break;
          case 'copilot-close':
            closeEngine(h, frame.projectPath);
            break;
          case 'copilot-dismiss':
            handleDismiss(h, frame);
            break;
          case 'copilot-mode':
            await handleMode(h, frame);
            break;
        }
      };
      void run().catch((err) => console.warn(`[copilot] key=${short(liveKey)} frame ${frame.type} failed: ${(err as Error).name}`));
    },
    detach() {
      h.sockets.delete(send);
      if (h.sockets.size === 0 && hubs.get(liveKey) === h && !h.graceTimer) {
        h.graceTimer = setTimeout(() => {
          h.graceTimer = null;
          void stopCopilotLiveKey(liveKey, 'socket-grace');
        }, SOCKET_GRACE_MS);
        h.graceTimer.unref?.();
      }
    },
  };
}

/// Stops every child and timer of the meeting at once and forgets its state.
export async function stopCopilotLiveKey(liveKey: string, why: string): Promise<void> {
  const hub = hubs.get(liveKey);
  if (!hub) return;
  hubs.delete(liveKey);
  hub.closed = true;
  if (hub.graceTimer) clearTimeout(hub.graceTimer);
  hub.graceTimer = null;
  if (hub.praxisRetry) clearInterval(hub.praxisRetry);
  hub.praxisRetry = null;
  hub.unsubscribeFeed?.();
  hub.unsubscribeFeed = null;
  const engines = [...hub.engines.values()];
  hub.engines.clear();
  console.log(`[copilot] key=${short(liveKey)} stop why=${why} tabs=${engines.length}`);
  await Promise.all(engines.map((e) => stopEngine(e)));
  hub.sockets.clear();
}

export async function stopAllCopilots(): Promise<void> {
  await Promise.all([...hubs.keys()].map((k) => stopCopilotLiveKey(k, 'server-closing')));
}

/// For process 'exit': synchronous, best effort, per platform.
export function killAllCopilotsSync(): void {
  for (const hub of hubs.values()) {
    for (const eng of hub.engines.values()) {
      for (const child of [eng.explain, eng.always?.child]) {
        const pid = child?.pid;
        if (!pid) continue;
        try {
          if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          else process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
}
