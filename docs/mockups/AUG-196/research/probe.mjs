// AUG-196 scratch: find_task_by_keywords latency and hit check over Praxis MCP HTTP.
const U = 'http://127.0.0.1:7865/stream'; let sid;
async function rpc(method, params, id) {
  const r = await fetch(U, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(id == null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) });
  sid = sid || r.headers.get('mcp-session-id');
  const t = await r.text();
  return t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((x) => x.id === id);
}
await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p', version: '0' } }, 1);
await rpc('notifications/initialized', {}, null);
const Q = [['D:\\claude\\git\\squarefi-crm', 'тариф'], ['D:\\claude\\git\\squarefi-crm', 'эскалац'], ['D:\\claude\\git\\squarefi-crm', 'L2'], ['D:\\claude\\August', 'копайлот'], ['D:\\claude\\August', 'тариф лимит']];
let i = 5;
for (const [root, kw] of Q) {
  const t0 = performance.now();
  const r = await rpc('tools/call', { name: 'find_task_by_keywords', arguments: { project_root: root, query: kw } }, i++);
  const txt = r?.result?.content?.map((c) => c.text).join('\n') || JSON.stringify(r?.error || r);
  console.log('##', root.split('\\').pop(), kw, Math.round(performance.now() - t0) + 'ms\n', txt.slice(0, 350));
}
