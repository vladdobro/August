import { describe, expect, test, vi } from 'vitest';

import {
  ClaudeTransport,
  JsonlSplitter,
  PRAXIS_KNOWN_TOOLS,
  buildClaudeArgs,
  buildCopilotArgs,
  buildMcpConfig,
  disallowedPraxisTools,
  notePraxisToolsFromInit,
  parseStreamMessage,
} from './claudeTransport.js';

const MCP = buildMcpConfig('http://127.0.0.1:3001/api/assistant/mcp/tok');
const base = { model: 'sonnet', sessionId: 'sid-1', resume: false, mcpConfig: MCP, disallowedTools: [] as string[], maxBudgetUsd: null as number | null, systemPrompt: 'PROMPT' };

describe('buildClaudeArgs', () => {
  test('exact order with session-id, no disallowed, no budget', () => {
    expect(buildClaudeArgs(base)).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', 'sonnet', '--session-id', 'sid-1', '--strict-mcp-config', '--mcp-config', JSON.stringify(MCP),
      '--tools', 'Read,Grep,Glob',
      '--allowedTools',
      'mcp__praxis__search_project_context', 'mcp__praxis__query_project_graph', 'mcp__praxis__read_context_route',
      'mcp__praxis__find_task_by_keywords', 'mcp__praxis__get_task', 'mcp__praxis__create_task',
      'mcp__august__*', 'Read', 'Grep', 'Glob',
      '--permission-prompts', 'none', '--setting-sources', '',
      '--append-system-prompt', 'PROMPT',
    ]);
  });

  test('resume replaces session-id', () => {
    const a = buildClaudeArgs({ ...base, resume: true });
    expect(a).toContain('--resume');
    expect(a).not.toContain('--session-id');
    expect(a[a.indexOf('--resume') + 1]).toBe('sid-1');
  });

  test('budget formatted when set, omitted when null', () => {
    const a = buildClaudeArgs({ ...base, maxBudgetUsd: 1.5 });
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('1.50');
    expect(a.indexOf('--max-budget-usd')).toBeLessThan(a.indexOf('--append-system-prompt'));
    expect(buildClaudeArgs(base)).not.toContain('--max-budget-usd');
  });

  test('disallowed tools are separate args between allowedTools and permission-prompts', () => {
    const a = buildClaudeArgs({ ...base, disallowedTools: ['mcp__praxis__update_task', 'mcp__praxis__health'] });
    const i = a.indexOf('--disallowedTools');
    expect(a.slice(i, i + 4)).toEqual(['--disallowedTools', 'mcp__praxis__update_task', 'mcp__praxis__health', '--permission-prompts']);
    expect(buildClaudeArgs(base)).not.toContain('--disallowedTools');
  });

  test('mcp-config is valid JSON with both servers', () => {
    const a = buildClaudeArgs(base);
    const cfg = JSON.parse(a[a.indexOf('--mcp-config') + 1]);
    expect(cfg.mcpServers.praxis).toEqual({ type: 'http', url: 'http://127.0.0.1:7865/stream' });
    expect(cfg.mcpServers.august).toEqual({ type: 'http', url: 'http://127.0.0.1:3001/api/assistant/mcp/tok' });
  });
});

describe('disallowedPraxisTools', () => {
  test('all known minus allowed, plus new tools seen in init', () => {
    const d = disallowedPraxisTools();
    expect(d).toHaveLength(PRAXIS_KNOWN_TOOLS.length - 6);
    expect(d).toContain('mcp__praxis__update_task_status');
    expect(d).not.toContain('mcp__praxis__create_task');
    notePraxisToolsFromInit(['Read', 'mcp__praxis__brand_new', 'mcp__praxis__get_task']);
    expect(disallowedPraxisTools()).toContain('mcp__praxis__brand_new');
  });
});

describe('JsonlSplitter', () => {
  test('buffers partial lines across chunks and skips blanks', () => {
    const s = new JsonlSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
  });
});

describe('parseStreamMessage', () => {
  test('partial text delta', () => {
    expect(
      parseStreamMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } }),
    ).toEqual([{ type: 'delta', text: 'Hel' }]);
    expect(parseStreamMessage({ type: 'stream_event', event: { type: 'message_start' } })).toEqual([]);
  });

  test('assistant tool_use keeps the full tool name', () => {
    const ev = parseStreamMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'tu1', name: 'mcp__praxis__get_task', input: { task_id: 'AUG-1' } }] },
    });
    expect(ev).toEqual([{ type: 'tool', id: 'tu1', name: 'mcp__praxis__get_task', input: { task_id: 'AUG-1' } }]);
  });

  test('user tool_result with string and block content', () => {
    expect(
      parseStreamMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] } }),
    ).toEqual([{ type: 'tool-result', id: 'tu1', isError: false, text: 'ok' }]);
    expect(
      parseStreamMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
      }),
    ).toEqual([{ type: 'tool-result', id: 'tu2', isError: true, text: 'a\nb' }]);
  });

  test('result: budget error with empty text', () => {
    expect(parseStreamMessage({ type: 'result', subtype: 'error_max_budget_usd', is_error: false, total_cost_usd: 0.012 })).toEqual([
      { type: 'result', subtype: 'error_max_budget_usd', isError: false, text: '', totalCostUsd: 0.012 },
    ]);
  });

  test('result: not logged in reported as success + is_error', () => {
    expect(
      parseStreamMessage({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', total_cost_usd: 0 }),
    ).toEqual([{ type: 'result', subtype: 'success', isError: true, text: 'Not logged in · Please run /login', totalCostUsd: 0 }]);
  });

  test('system init', () => {
    expect(
      parseStreamMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'abc',
        tools: ['Read', 'mcp__praxis__get_task'],
        mcp_servers: [{ name: 'praxis', status: 'connected' }, { name: 'august', status: 'failed' }],
      }),
    ).toEqual([
      { type: 'init', sessionId: 'abc', tools: ['Read', 'mcp__praxis__get_task'], mcpServers: [{ name: 'praxis', status: 'connected' }, { name: 'august', status: 'failed' }] },
    ]);
  });

  test('unknown shapes give nothing', () => {
    expect(parseStreamMessage(null)).toEqual([]);
    expect(parseStreamMessage({ type: 'system', subtype: 'other' })).toEqual([]);
  });
});

describe('ClaudeTransport', () => {
  test('npm shim: exit unsupported without spawning', async () => {
    const spawn = vi.fn();
    const t = new ClaudeTransport({ spawn: spawn as never });
    const exit = new Promise((resolve) => t.once('exit', resolve));
    t.start({ cli: { path: 'C:\\npm\\claude.cmd', shim: true }, args: [], cwd: '.' });
    expect(await exit).toEqual({ code: null, reason: 'unsupported' });
    expect(spawn).not.toHaveBeenCalled();
    expect(t.alive).toBe(false);
  });
});

describe('buildCopilotArgs', () => {
  const o = { model: 'haiku', sessionId: 'sid-2', maxBudgetUsd: null as number | null, systemPrompt: 'P' };

  test('search-only tools, praxis only, no file tools', () => {
    const a = buildCopilotArgs(o);
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).toContain('mcp__praxis__search_project_context');
    expect(a).toContain('mcp__praxis__find_task_by_keywords');
    for (const t of ['Read', 'Grep', 'Glob']) expect(a).not.toContain(t);
    expect(a.join(' ')).not.toContain('august');
    const cfg = JSON.parse(a[a.indexOf('--mcp-config') + 1]);
    expect(Object.keys(cfg.mcpServers)).toEqual(['praxis']);
    const i = a.indexOf('--disallowedTools');
    expect(a.slice(i + 1)).toContain('mcp__praxis__create_task');
    expect(a.slice(i + 1, a.indexOf('--permission-prompts'))).not.toContain('mcp__praxis__search_project_context');
    expect(a[a.indexOf('--session-id') + 1]).toBe('sid-2');
    expect(a[a.length - 2]).toBe('--append-system-prompt');
  });

  test('budget formatted when set, omitted when null', () => {
    expect(buildCopilotArgs(o)).not.toContain('--max-budget-usd');
    const a = buildCopilotArgs({ ...o, maxBudgetUsd: 0.5 });
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('0.50');
  });
});
