import { randomUUID } from 'node:crypto';

import { getLiveFeed, type LiveFeed } from './liveFeed.js';
import { getOpenLiveActionItems, type LiveActionItemsStore } from './liveActionItems.js';

/// AUG-199: the "august" MCP server (Streamable HTTP, JSON responses) that the assistant's Claude child talks to. One token per tab child -> {liveKey, projectPath}.
/// Arguments and results are never logged.

export interface McpTokenInfo {
  liveKey: string;
  projectPath: string;
}

const tokens = new Map<string, McpTokenInfo>();

export function registerMcpToken(info: McpTokenInfo): string {
  const token = randomUUID();
  tokens.set(token, { ...info });
  return token;
}

export function revokeMcpToken(token: string): void {
  tokens.delete(token);
}

export function lookupMcpToken(token: string): McpTokenInfo | null {
  return tokens.get(token) ?? null;
}

export interface McpDeps {
  getStore: (liveKey: string) => LiveActionItemsStore | null;
  getFeed: (liveKey: string) => LiveFeed | null;
}

export interface McpHttpResult {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
}

const TOOLS = [
  {
    name: 'get_recent_transcript',
    description: 'Last N minutes (1-15) of the live meeting transcript, one line per utterance: [Me|Them] hh:mm:ss text. Empty when the recording runs without Live Text.',
    inputSchema: {
      type: 'object',
      properties: { minutes: { type: 'number', description: 'How many minutes back, 1 to 15 (default 5).' } },
    },
  },
  {
    name: 'list_action_items',
    description: 'List the action items recorded so far in this meeting.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_action_item',
    description: 'Record one action item (1-300 characters). Duplicates are detected and reported, not added twice.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Short task text, 1-300 characters.' },
        owner: { type: 'string', enum: ['Me', 'Them'] },
        praxisTaskId: { type: 'string', description: 'Id of the Praxis task created for this item, if any.' },
        projectPath: { type: 'string' },
      },
      required: ['text'],
    },
  },
];

type RpcMsg = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function callTool(
  name: string,
  args: Record<string, unknown>,
  token: McpTokenInfo,
  deps: McpDeps,
): { ok: unknown } | { error: { code: number; message: string } } {
  switch (name) {
    case 'get_recent_transcript': {
      const raw = typeof args.minutes === 'number' && Number.isFinite(args.minutes) ? args.minutes : 5;
      const minutes = Math.min(15, Math.max(1, Math.round(raw)));
      const feed = deps.getFeed(token.liveKey);
      // AUG-200: meeting-only socket has no feed
      if (!feed) return { ok: { window_min: minutes, lines: [], note: 'No live transcript: this recording runs without Live Text. Answer from the project notes and the action items.' } };
      return { ok: { window_min: minutes, lines: feed ? feed.snapshot(minutes * 60_000).map((l) => feed.formatLine(l)) : [] } };
    }
    case 'list_action_items': {
      const store = deps.getStore(token.liveKey);
      return {
        ok: {
          items: (store?.file.items ?? []).map((i) => ({
            id: i.id,
            text: i.text,
            owner: i.owner,
            ...(i.praxis ? { praxisTaskId: i.praxis.taskId } : {}),
          })),
        },
      };
    }
    case 'add_action_item': {
      const store = deps.getStore(token.liveKey);
      if (!store) return { error: { code: -32603, message: 'No live meeting' } };
      const r = store.addAssistantItem({
        text: args.text,
        owner: args.owner,
        praxisTaskId: args.praxisTaskId,
        projectPath: typeof args.projectPath === 'string' && args.projectPath ? args.projectPath : token.projectPath,
      });
      if (!r) return { error: { code: -32602, message: 'text must be 1-300 characters' } };
      return { ok: r };
    }
    default:
      return { error: { code: -32602, message: 'Unknown tool' } };
  }
}

function handleOne(msg: RpcMsg, token: McpTokenInfo, deps: McpDeps): { out: unknown | null; sessionHeader?: string } {
  if (msg.id === undefined || msg.id === null) return { out: null }; // notification
  const id = msg.id;
  const params = isObj(msg.params) ? msg.params : {};
  switch (msg.method) {
    case 'initialize':
      return {
        out: {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'august', version: '1.0.0' } },
        },
        sessionHeader: randomUUID(),
      };
    case 'ping':
      return { out: { jsonrpc: '2.0', id, result: {} } };
    case 'tools/list':
      return { out: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const r = callTool(name, isObj(params.arguments) ? params.arguments : {}, token, deps);
      if ('error' in r) return { out: rpcError(id, r.error.code, r.error.message) };
      return { out: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r.ok) }] } } };
    }
    default:
      return { out: rpcError(id, -32601, 'Method not found') };
  }
}

export function handleMcpPost(
  token: string,
  body: unknown,
  deps: McpDeps = { getStore: getOpenLiveActionItems, getFeed: getLiveFeed },
): McpHttpResult {
  const info = lookupMcpToken(token);
  if (!info) return { status: 404, headers: {} };
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]).filter(isObj) as RpcMsg[];
  if (msgs.length === 0) return { status: 400, headers: {} };
  const outs: unknown[] = [];
  let sessionHeader: string | undefined;
  for (const m of msgs) {
    const r = handleOne(m, info, deps);
    if (r.sessionHeader) sessionHeader = r.sessionHeader;
    if (r.out !== null) outs.push(r.out);
  }
  if (outs.length === 0) return { status: 202, headers: {} };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionHeader) headers['Mcp-Session-Id'] = sessionHeader;
  return { status: 200, headers, json: batch ? outs : outs[0] };
}

/// For the route's log line: method names only.
export function mcpMethodNames(body: unknown): string {
  const list = Array.isArray(body) ? body : [body];
  return list.map((m) => (isObj(m) && typeof m.method === 'string' ? m.method : '?')).join(',');
}
