// AUG-196 scratch: latency + cost of the V3 explanation turn on a persistent stream-json Claude child.
// Usage: node explain-bench.mjs <model> <project_root> <mode: explain|assist>
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const [, , model = 'haiku', projectRoot = 'D:\\claude\\git\\squarefi-crm', mode = 'explain'] = process.argv;
const exe = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const mcp = JSON.stringify({ mcpServers: { praxis: { type: 'http', url: 'http://127.0.0.1:7865/stream' } } });

const SYS = [
  'You are the Meeting Copilot of August. You get a short fragment of a live meeting transcript in which someone refers to a past agreement, plus candidate notes from the PraxisOS project knowledge base.',
  'Reply with exactly one line of JSON: {"verdict":"match"|"none","text":"<one sentence in the meeting language, max 160 chars>","source":"<route or task id>"}.',
  'verdict "match" only if a candidate note states the agreement or decision being referred to; otherwise {"verdict":"none"}.',
  'Never invent facts that are not in the candidates. No markdown, no extra text.',
].join(' ');
const SYS_ASSIST = SYS + ` If the candidates are empty or irrelevant, you may call mcp__praxis__search_project_context and mcp__praxis__find_task_by_keywords once each with 2-4 English keywords (project_root=${projectRoot}) before answering.`;

// three real fires from the 57-min Support Weekly (ac0169f7), with the local g2 search result (partial, irrelevant)
const CASES = [
  { lines: ['[Them] И более того, мы в прошлый раз обсуждали, что у CSM из их live-чатов, у них тоже должна быть кнопка "Эскалировать тикет вол2".', '[Me] Да, это есть в макете.'],
    hits: ['project-context/support/inbox/README.md L12: Email in the UI (PR #1035): sky «Email» chip (TicketChannelBadge) in the ticket panel, queue, archive, chat list and header'] },
  { lines: ['[Me] А, еще мы с вами договорились, что мы соберем в кучу вот эти все тарифы по мосте с лимитами, но это уже, наверное, не я буду делать.'], hits: [] },
  { lines: ['[Me] Мы на прошлой встрече смотрели на цифры.', '[Me] Верить им, как мы в тот раз решили, особо нельзя.'], hits: [] },
];

const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model,
  '--strict-mcp-config', '--mcp-config', mcp, '--setting-sources', '', '--tools', '',
  '--allowedTools', 'mcp__praxis__search_project_context', 'mcp__praxis__find_task_by_keywords',
  '--append-system-prompt', mode === 'assist' ? SYS_ASSIST : SYS, '--max-budget-usd', '0.5'];
const t0 = performance.now();
const ch = spawn(exe, args, { cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', turn = -1, tSend = 0, firstTok = 0, tools = [];
const results = [];
ch.stderr.on('data', (d) => process.stderr.write('ERR ' + d));
function send(i) {
  const c = CASES[i];
  const content = `<trigger_lines>\n${c.lines.join('\n')}\n</trigger_lines>\n<candidates>\n${c.hits.join('\n') || '(none)'}\n</candidates>`;
  turn = i; tSend = performance.now(); firstTok = 0; tools = [];
  ch.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
}
send(0);
ch.stdout.on('data', (d) => {
  buf += d; let k;
  while ((k = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, k); buf = buf.slice(k + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'system' && m.subtype === 'init') { results.push({ init_ms: Math.round(performance.now() - t0) }); }
    if (m.type === 'assistant') { if (!firstTok) firstTok = performance.now(); for (const b of m.message.content || []) if (b.type === 'tool_use') tools.push(b.name.replace('mcp__praxis__', '')); }
    if (m.type === 'result') {
      results.push({ turn, ms: Math.round(performance.now() - tSend), first_ms: firstTok ? Math.round(firstTok - tSend) : null, api_ms: m.duration_api_ms, cost: m.total_cost_usd, tools, usage: m.usage && { in: m.usage.input_tokens, out: m.usage.output_tokens, cr: m.usage.cache_read_input_tokens, cw: m.usage.cache_creation_input_tokens }, text: String(m.result).slice(0, 300) });
      if (turn + 1 < CASES.length) send(turn + 1); else ch.stdin.end();
    }
  }
});
ch.on('exit', (code) => { clearTimeout(T); console.log(JSON.stringify({ model, mode, code, wall_ms: Math.round(performance.now() - t0), results }, null, 1)); });
const T = setTimeout(() => { console.log('TIMEOUT', JSON.stringify(results)); ch.kill(); }, 240000);
