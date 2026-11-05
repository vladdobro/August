// AUG-196 scratch: offline evaluation of the Meeting Copilot gate on real transcripts.
// Usage: node gate-eval.mjs <transcript.md> <project_root> [--variant=base|strict] [--json=out.json]
// Not product code. Talks to Praxis MCP over Streamable HTTP (127.0.0.1:7865/stream).
import fs from 'node:fs';

const [, , file, projectRoot, ...rest] = process.argv;
const opts = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
const VARIANT = opts.variant || 'base';
const MCP = 'http://127.0.0.1:7865/stream';

// ---------- transcript parsing ----------
function toSec(t) { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; }
function parse(md) {
  const raw = [];
  for (const l of md.split(/\r?\n/)) {
    const m = l.match(/^\[(\d\d:\d\d:\d\d)\]\s*(?:\[(Me|Them)\]\s*)?(.*)$/);
    if (m && m[3].trim()) raw.push({ at: toSec(m[1]), speaker: m[2] || 'Them', text: m[3].trim() });
  }
  const dur = md.match(/Duration:\s*(\d\d:\d\d:\d\d)/);
  const end = dur ? toSec(dur[1]) : (raw.at(-1)?.at ?? 0) + 10;
  // split long lines into sentences (live lines are ~4 s chunks, ~10-25 words)
  const out = [];
  raw.forEach((r, i) => {
    const next = i + 1 < raw.length ? raw[i + 1].at : end;
    const sents = r.text.split(/(?<=[.!?…])\s+/).filter(Boolean);
    const words = sents.map((s) => s.split(/\s+/).length);
    const total = words.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    sents.forEach((s, j) => {
      out.push({ at: r.at + Math.round(((next - r.at) * acc) / total), speaker: r.speaker, text: s });
      acc += words[j];
    });
  });
  return { lines: out, end };
}

// ---------- gate ----------
const TRIG_RU = ['договаривались', 'договорились', 'в прошлый раз', 'как обсуждали', 'мы же решили', 'ты обещал', 'помнишь', 'на прошлой встрече', 'по задаче'];
const TRIG_EN = ['we agreed', 'last time', 'as discussed', 'you promised', 'remember when', 'the ticket', 'the task'];
// strict variant adds ru inflections and drops nothing; entity rule tightened
const TRIG_RU_EXTRA = ['обсуждали', 'обещали', 'обещал', 'решили', 'договорённост', 'договоренност', 'напомни', 'как мы говорили', 'на прошлой неделе', 'тикет', 'задач'];
const TRIGGERS = VARIANT === 'strict' ? [...TRIG_RU, ...TRIG_EN, ...TRIG_RU_EXTRA] : [...TRIG_RU, ...TRIG_EN];

const TASK_ID = /\b[A-Z]{2,5}-\d{1,5}\b/;
const QUOTED = /[«"“]([^»"”]{3,40})[»"”]/;
const LATIN_CAP = /\b[A-Z][a-zA-Z]{3,}\b/g;
const COMMON_LATIN = new Set(['Welcome', 'Okay', 'Hello', 'Thanks', 'Thank', 'Sorry', 'Yeah', 'Well', 'Just', 'This', 'That', 'What', 'When', 'Where', 'There', 'They', 'Then', 'Some', 'Good', 'Great', 'Nice', 'Right', 'Sure', 'Also', 'Please', 'Steam']);

const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это эта эти просто какие очень вообще типа вроде значит давай давайте сейчас ещё говорю кстати точно потому смотри слушай понял понятно короче например надо нужно хочу хотел могу может будем есть было были будет мы наш наши нашей нашего ваш ваши свой своих своей который которые которая которого также только всего самое самый там тут здесь тоже тогда сначала потом этот этом этих этому такие такое такая такую какой какая какие какое чего чему чем кого кому почему зачем куда откуда сколько либо нибудь буду будут хотя ладно ага угу окей ок да нет вот ну типа блин '
  + 'the a an and or but if then so of to in on at by for with from is are was were be been being have has had do does did not no yes it its this that these those there here we you they he she i me my our your their them us as about into over just very really also can could would should will shall may might must what which who whom whose when where why how all any some more most other such only own same than too okay yeah well right').split(/\s+/));

function words(t) { return t.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9-]+/gi) || []; }
function keywordsOf(lines) {
  const ws = lines.flatMap((l) => words(l.text)).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  // keep the last occurrences, prefer longer words
  const uniq = [...new Set(ws.reverse())];
  return uniq.sort((a, b) => b.length - a.length).slice(0, 6);
}

// ---------- g2: stem triggers + task id; lexicon only feeds keywords ----------
const G2_TRIG = [
  /(?<!\p{L})(договар|договорил|договоренност)\p{L}*/u,
  /(?<!\p{L})(мы|вы|ты|с тобой|с вами)\s+(же\s+)?(\p{L}+\s+)?(обсуждал|решил|обещал|говорил)\p{L}*/u,
  /(?<!\p{L})в (прошлый|тот|прошлом) раз/u, /(?<!\p{L})на прошлой (встрече|созвоне|планерке)/u, /(?<!\p{L})(помнишь|напомни)/u,
  /\b((we|you) (agreed|decided|discussed|promised)|last (time|meeting|call)|as (discussed|agreed)|remember when)\b/u,
];
let LEX = [];
function buildLexicon(root) {
  const terms = new Set();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = d + '/' + e.name;
    if (e.isDirectory()) { if (e.name.length >= 4) terms.add(e.name.toLowerCase()); walk(f); }
    else if (e.name === 'README.md') {
      const txt = fs.readFileSync(f, 'utf8');
      for (const m of txt.matchAll(/Also known as:([^\n]*)/g)) for (const t of m[1].split(/[,;]/)) { const w = t.replace(/\(.*?\)/g, '').trim().toLowerCase(); if (w.length >= 4 && w.length <= 30) terms.add(w); }
      for (const m of txt.matchAll(/[A-Z][a-z]+[A-Z][A-Za-z]+|[A-Z]{3,}/g)) terms.add(m[0].toLowerCase());
    } } };
  walk(root.split('\\').join('/') + '/project-context');
  return [...terms];
}
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return d[a.length][b.length]; }
function lexHits(text) {
  const out = [];
  const toks = (text.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []).map((w) => w.toLowerCase());
  for (const w of toks) { for (const t of LEX) { if (t.includes(' ')) continue; if (t === w || (w.length >= 5 && Math.abs(t.length - w.length) <= 2 && lev(t, w) <= 2)) { out.push(t); break; } } }
  for (const t of LEX) if (t.includes(' ') && text.toLowerCase().includes(t)) out.push(t);
  return [...new Set(out)];
}
function gate(line) {
  const t = line.text.toLowerCase().replace(/ё/g, 'е');
  if (VARIANT === 'g2') {
    for (const r of G2_TRIG) { const m = t.match(r); if (m) return { rule: 'trigger', hit: m[0] }; }
    if (TASK_ID.test(line.text)) return { rule: 'taskid', hit: line.text.match(TASK_ID)[0] };
    return null;
  }
  for (const p of TRIGGERS) if (t.includes(p)) return { rule: 'trigger', hit: p };
  if (TASK_ID.test(line.text)) return { rule: 'taskid', hit: line.text.match(TASK_ID)[0] };
  if (VARIANT !== 'strict') {
    const q = line.text.match(QUOTED); if (q) return { rule: 'quoted', hit: q[1] };
    const caps = (line.text.match(LATIN_CAP) || []).filter((w) => !COMMON_LATIN.has(w));
    if (caps.length) return { rule: 'latincap', hit: caps[0] };
  }
  return null;
}

// ---------- MCP client ----------
let sid = null;
async function rpc(method, params, id) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(id == null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
  });
  if (!sid) sid = r.headers.get('mcp-session-id');
  const body = await r.text();
  const data = body.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return data.find((d) => d.id === id) || (body.trim().startsWith('{') ? JSON.parse(body) : null);
}
let nid = 10;
async function init() {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'aug196-gate-eval', version: '0' } }, 1);
  await rpc('notifications/initialized', {}, null);
}
async function search(query) {
  const t0 = performance.now();
  const res = await rpc('tools/call', { name: 'search_project_context', arguments: { project_root: projectRoot, query } }, nid++);
  const ms = performance.now() - t0;
  const text = res?.result?.content?.map((c) => c.text).join('\n') || '';
  const blocks = [];
  let cur = null;
  for (const l of text.split(/\r?\n/)) {
    const h = l.match(/^(\S.*?README\.md|\S+\.md)\s+\[(exact|partial)(?:, missing: ([^\]]*))?\]/);
    if (h) { cur = { path: h[1], kind: h[2], missing: h[3] || '', lines: [] }; blocks.push(cur); continue; }
    const m = l.match(/^L(\d+):\s*(.*)$/);
    if (m && cur) cur.lines.push({ n: +m[1], text: m[2].slice(0, 160) });
  }
  return { blocks, ms };
}

// ---------- run ----------
const md = fs.readFileSync(file, 'utf8');
const { lines, end } = parse(md);
const hours = end / 3600;
if (VARIANT === 'g2') { LEX = buildLexicon(projectRoot); console.error('lexicon terms', LEX.length); }
await init();

const MIN_GAP = Number(opts.gap || 20), ROUTE_COOLDOWN = 300, MAX_PER_HOUR = Number(opts.cap || 12);
let lastSearch = -1e9;
const routeShown = new Map();
const cards = [], fires = [], searches = [];
const ruleCount = {};
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  const g = gate(ln);
  if (!g) continue;
  fires.push({ at: ln.at, ...g, text: ln.text.slice(0, 220) });
  ruleCount[g.rule] = (ruleCount[g.rule] || 0) + 1;
  if (ln.at - lastSearch < MIN_GAP) continue;
  lastSearch = ln.at;
  let kws = keywordsOf(lines.slice(Math.max(0, i - 1), i + 1));
  if (VARIANT === 'g2') {
    const ctx = lines.slice(Math.max(0, i - 2), i + 2).map((l) => l.text).join(' ');
    const lex = lexHits(ctx).slice(0, 3);
    const id = ctx.match(TASK_ID);
    kws = [...(id ? [id[0]] : []), ...lex, ...kws].slice(0, 4);
  }
  if (kws.length < (VARIANT === 'g2' ? 1 : 2)) { searches.push({ at: ln.at, kws, skipped: 'few keywords' }); continue; }
  const { blocks, ms } = await search(kws.join(' '));
  const top = blocks[0];
  const exact = top && top.kind === 'exact';
  const partial2 = top && top.kind === 'partial' && top.lines.length >= 2;
  searches.push({ at: ln.at, rule: g.rule, kws, ms: Math.round(ms), top: top ? `${top.path} [${top.kind}${top.missing ? ', missing: ' + top.missing : ''}]` : null, exact });
  if (!(exact || partial2)) continue;
  const route = top.path;
  if (routeShown.has(route) && ln.at - routeShown.get(route) < ROUTE_COOLDOWN) continue;
  const inHour = cards.filter((c) => ln.at - c.at < 3600).length;
  if (inHour >= MAX_PER_HOUR) continue;
  routeShown.set(route, ln.at);
  cards.push({ at: ln.at, rule: g.rule, hit: g.hit, kind: top.kind, route, line: ln.text.slice(0, 200), kws, snippet: top.lines.slice(0, 2) });
}

const fmt = (s) => new Date(s * 1000).toISOString().slice(11, 19);
const summary = {
  file: file.split(/[\\/]/).slice(-2).join('/'), project: projectRoot, variant: VARIANT,
  minutes: +(end / 60).toFixed(1), lines: lines.length,
  fires: fires.length, firesPerHour: +(fires.length / hours).toFixed(1), byRule: ruleCount,
  searches: searches.filter((s) => !s.skipped).length,
  exactTop: searches.filter((s) => s.exact).length,
  cards: cards.length, cardsPerHour: +(cards.length / hours).toFixed(1),
  searchMs: (() => { const a = searches.filter((s) => s.ms).map((s) => s.ms).sort((x, y) => x - y); return a.length ? { p50: a[a.length >> 1], max: a.at(-1) } : null; })(),
};
console.log(JSON.stringify(summary, null, 1));
for (const c of cards) console.log(`CARD ${fmt(c.at)} [${c.rule}:${c.hit}] ${c.kind} ${c.route}\n   said: ${c.line}\n   kws: ${c.kws.join(' ')}\n   ${c.snippet.map((s) => 'L' + s.n + ': ' + s.text).join('\n   ')}`);
if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ summary, fires, searches, cards }, null, 1));
