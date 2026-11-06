import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { buildClaudeEnv, type ResolvedClaudeCli } from './claudeCli.js';

/// AUG-199 (shared with AUG-197): one `claude -p` stream-json child. Spawn, JSONL framing, stdin messages, interrupt and per-platform process-tree stop.
/// Never logs or stores stream content; stderr is only counted.

export const PRAXIS_ALLOWED_TOOLS = [
  'search_project_context',
  'query_project_graph',
  'read_context_route',
  'find_task_by_keywords',
  'get_task',
  'create_task',
] as const;

export const PRAXIS_KNOWN_TOOLS: string[] = [
  'create_assignee',
  'create_task',
  'execute_command',
  'find_assignee_by_keywords',
  'find_task_by_keywords',
  'get_active_tasks',
  'get_assignees',
  'get_next_task_id',
  'get_settings',
  'get_task',
  'health',
  'list_tasks',
  'query_project_graph',
  'read_context_route',
  'reconcile_task_statuses',
  'search_project_context',
  'start_new_session',
  'update_project_context',
  'update_settings',
  'update_task',
  'update_task_status',
];

const PRAXIS_PREFIX = 'mcp__praxis__';

let praxisToolNames: string[] = PRAXIS_KNOWN_TOOLS;

/// Keeps every `mcp__praxis__X` tool seen in an init message (a newer Praxis may add tools).
export function notePraxisToolsFromInit(tools: string[]): void {
  const seen = tools.filter((t) => t.startsWith(PRAXIS_PREFIX)).map((t) => t.slice(PRAXIS_PREFIX.length));
  praxisToolNames = Array.from(new Set([...praxisToolNames, ...seen]));
}

export function disallowedPraxisTools(): string[] {
  const allowed = new Set<string>(PRAXIS_ALLOWED_TOOLS);
  return praxisToolNames.filter((n) => !allowed.has(n)).map((n) => `${PRAXIS_PREFIX}${n}`);
}

export interface ClaudeArgsOptions {
  model: string;
  sessionId: string;
  resume: boolean;
  mcpConfig: object;
  disallowedTools: string[];
  maxBudgetUsd: number | null;
  systemPrompt: string;
}

export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', o.model,
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(o.mcpConfig),
    '--tools', 'Read,Grep,Glob',
    '--allowedTools',
    ...PRAXIS_ALLOWED_TOOLS.map((t) => `${PRAXIS_PREFIX}${t}`),
    'mcp__august__*',
    'Read',
    'Grep',
    'Glob',
    ...(o.disallowedTools.length > 0 ? ['--disallowedTools', ...o.disallowedTools] : []),
    '--permission-prompts', 'none',
    '--setting-sources', '',
    ...(o.maxBudgetUsd !== null ? ['--max-budget-usd', o.maxBudgetUsd.toFixed(2)] : []),
    '--append-system-prompt', o.systemPrompt,
  ];
}

/// AUG-197: the copilot child may only search; it has no file tools and no august server.
export const COPILOT_ALLOWED_TOOLS = ['search_project_context', 'find_task_by_keywords'] as const;

export function buildCopilotArgs(o: { model: string; sessionId: string; maxBudgetUsd: number | null; systemPrompt: string }): string[] {
  const allowed = new Set<string>(COPILOT_ALLOWED_TOOLS);
  const disallowed = praxisToolNames.filter((n) => !allowed.has(n)).map((n) => `${PRAXIS_PREFIX}${n}`);
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', o.model,
    '--session-id', o.sessionId,
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: { praxis: { type: 'http', url: 'http://127.0.0.1:7865/stream' } } }),
    '--tools', '',
    '--allowedTools',
    ...COPILOT_ALLOWED_TOOLS.map((t) => `${PRAXIS_PREFIX}${t}`),
    ...(disallowed.length > 0 ? ['--disallowedTools', ...disallowed] : []),
    '--permission-prompts', 'none',
    '--setting-sources', '',
    ...(o.maxBudgetUsd !== null ? ['--max-budget-usd', o.maxBudgetUsd.toFixed(2)] : []),
    '--append-system-prompt', o.systemPrompt,
  ];
}

export function buildMcpConfig(augustUrl: string): { mcpServers: Record<string, { type: 'http'; url: string }> } {
  return {
    mcpServers: {
      praxis: { type: 'http', url: 'http://127.0.0.1:7865/stream' },
      august: { type: 'http', url: augustUrl },
    },
  };
}

export type TransportEvent =
  | { type: 'init'; sessionId: string | null; tools: string[]; mcpServers: Array<{ name: string; status: string }> }
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; id: string; isError: boolean; text: string }
  | { type: 'result'; subtype: string; isError: boolean; text: string; totalCostUsd: number | null };

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const o = obj(b);
    if (o && o.type === 'text' && typeof o.text === 'string') parts.push(o.text);
  }
  return parts.join('\n');
}

/// Pure: one stream-json message -> zero or more events.
export function parseStreamMessage(msg: unknown): TransportEvent[] {
  const m = obj(msg);
  if (!m) return [];
  const out: TransportEvent[] = [];
  switch (m.type) {
    case 'system': {
      if (m.subtype !== 'init') return out;
      const tools = Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === 'string') : [];
      const mcpServers: Array<{ name: string; status: string }> = [];
      if (Array.isArray(m.mcp_servers)) {
        for (const s of m.mcp_servers) {
          const so = obj(s);
          if (so && typeof so.name === 'string') mcpServers.push({ name: so.name, status: typeof so.status === 'string' ? so.status : '' });
        }
      }
      out.push({ type: 'init', sessionId: typeof m.session_id === 'string' ? m.session_id : null, tools, mcpServers });
      return out;
    }
    case 'stream_event': {
      const ev = obj(m.event);
      const delta = obj(ev?.delta);
      if (ev?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        out.push({ type: 'delta', text: delta.text });
      }
      return out;
    }
    case 'assistant': {
      const content = obj(m.message)?.content;
      if (!Array.isArray(content)) return out;
      for (const b of content) {
        const bo = obj(b);
        if (bo?.type === 'tool_use' && typeof bo.id === 'string' && typeof bo.name === 'string') {
          out.push({ type: 'tool', id: bo.id, name: bo.name, input: obj(bo.input) ?? {} });
        }
      }
      return out;
    }
    case 'user': {
      const content = obj(m.message)?.content;
      if (!Array.isArray(content)) return out;
      for (const b of content) {
        const bo = obj(b);
        if (bo?.type === 'tool_result' && typeof bo.tool_use_id === 'string') {
          out.push({ type: 'tool-result', id: bo.tool_use_id, isError: bo.is_error === true, text: resultText(bo.content) });
        }
      }
      return out;
    }
    case 'result': {
      out.push({
        type: 'result',
        subtype: typeof m.subtype === 'string' ? m.subtype : '',
        isError: m.is_error === true,
        text: String(m.result ?? ''),
        totalCostUsd: typeof m.total_cost_usd === 'number' && Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : null,
      });
      return out;
    }
    default:
      return out;
  }
}

/// Buffers partial lines across chunks.
export class JsonlSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let k: number;
    while ((k = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, k);
      this.buf = this.buf.slice(k + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  }
}

export interface TransportExit {
  code: number | null;
  signal?: string | null;
  reason?: 'unsupported';
}

export interface TransportDeps {
  spawn: typeof nodeSpawn;
  platform: NodeJS.Platform;
  killTree: (pid: number) => void;
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
}

/// win32: process tree via taskkill (the child may have spawned MCP helpers). Elsewhere never called.
function defaultKillTree(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } catch {
    // already gone
  }
}

const STOP_GRACE_MS = 5000;

export class ClaudeTransport extends EventEmitter {
  private child: ChildProcess | null = null;
  private exited = false;
  private exitEmitted = false;
  private stderrBytes = 0;
  private readonly deps: TransportDeps;

  constructor(deps: Partial<TransportDeps> = {}) {
    super();
    this.deps = {
      spawn: deps.spawn ?? nodeSpawn,
      platform: deps.platform ?? process.platform,
      killTree: deps.killTree ?? defaultKillTree,
      setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    };
  }

  get alive(): boolean {
    return !!this.child && !this.exited;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get stderrByteCount(): number {
    return this.stderrBytes;
  }

  private emitExit(info: TransportExit): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.exited = true;
    this.emit('exit', info);
  }

  start(o: { cli: ResolvedClaudeCli; args: string[]; cwd: string }): void {
    if (o.cli.shim) {
      // An npm .cmd shim cannot carry JSON arguments safely.
      this.exited = true;
      queueMicrotask(() => this.emitExit({ code: null, reason: 'unsupported' }));
      return;
    }
    let child: ChildProcess;
    try {
      child = this.deps.spawn(o.cli.path, o.args, {
        cwd: o.cwd,
        env: buildClaudeEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.exited = true;
      queueMicrotask(() => this.emitExit({ code: null }));
      return;
    }
    this.child = child;
    const splitter = new JsonlSplitter();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of parseStreamMessage(parsed)) this.emit(ev.type, ev);
      }
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      this.stderrBytes += d.length;
    });
    child.stdin?.on('error', () => {});
    child.on('error', () => this.emitExit({ code: null }));
    child.on('exit', (code, signal) => this.emitExit({ code, signal }));
  }

  private write(line: string): boolean {
    const stdin = this.child?.stdin;
    if (!this.alive || !stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(line + '\n');
      return true;
    } catch {
      return false;
    }
  }

  send(text: string): boolean {
    return this.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
  }

  interrupt(): boolean {
    return this.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }));
  }

  /// Graceful: ends stdin (win32) or SIGTERM; hard stop after 5 s. Resolves on exit.
  stop(): Promise<void> {
    const child = this.child;
    if (!child || !this.alive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.once('exit', done);
      if (this.deps.platform === 'win32') {
        try { child.stdin?.end(); } catch { /* closed */ }
      } else {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
      }
      timer = this.deps.setTimeout(() => {
        if (!this.alive) return;
        this.hardKill(child);
      }, STOP_GRACE_MS);
      timer.unref?.();
    });
  }

  /// Immediate hard kill, no grace.
  kill(): void {
    const child = this.child;
    if (!child || !this.alive) return;
    this.hardKill(child);
  }

  private hardKill(child: ChildProcess): void {
    if (this.deps.platform === 'win32') {
      if (typeof child.pid === 'number') this.deps.killTree(child.pid);
    } else {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
}
