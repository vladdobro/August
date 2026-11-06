import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleMcpPost, registerMcpToken, revokeMcpToken } from './augustMcp.js';
import { LiveActionItemsStore } from './liveActionItems.js';

// AUG-200: the august MCP tools on a recording without Live Text (no feed).
describe('august MCP without a live feed', () => {
  let tmpDir: string;
  let store: LiveActionItemsStore;
  let token: string;
  const deps = () => ({ getStore: () => store, getFeed: () => null });
  const call = (name: string, args: Record<string, unknown>) =>
    handleMcpPost(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, deps());
  const payload = (r: ReturnType<typeof handleMcpPost>) => JSON.parse((r.json as any).result.content[0].text);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aug200-'));
    store = new LiveActionItemsStore('k1', { version: 1, participants: { me: '', them: '' }, items: [], updatedAt: new Date().toISOString() }, path.join(tmpDir, 'k1.json'));
    token = registerMcpToken({ liveKey: 'k1', projectPath: 'C:/p' });
  });

  afterEach(async () => {
    revokeMcpToken(token);
    await store.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get_recent_transcript returns an empty window with a note', () => {
    const r = call('get_recent_transcript', { minutes: 5 });
    expect(r.status).toBe(200);
    expect((r.json as any).error).toBeUndefined();
    const p = payload(r);
    expect(p).toEqual({ window_min: 5, lines: [], note: expect.any(String) });
  });

  it('add_action_item creates a manual item and list_action_items shows it', () => {
    expect(payload(call('add_action_item', { text: 'Send the report' })).status).toBe('created');
    const list = payload(call('list_action_items', {}));
    expect(list.items).toHaveLength(1);
    expect(list.items[0].text).toBe('Send the report');
    expect(store.file.items[0].manual).toBe(true);
    expect(store.file.items[0].source).toBe('Me');
  });

  it('a near-duplicate is reported as duplicate', () => {
    call('add_action_item', { text: 'Send the report' });
    expect(payload(call('add_action_item', { text: 'send the report' })).status).toBe('duplicate');
    expect(store.file.items).toHaveLength(1);
  });

  it('an unknown token is 404', () => {
    const r = handleMcpPost('nope', { jsonrpc: '2.0', id: 1, method: 'ping' }, deps());
    expect(r.status).toBe(404);
  });
});
