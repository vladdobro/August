import { describe, test, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  renderActionItemsSection,
  upsertActionItemsSection,
  buildSeparateTaskDraft,
  buildCommonTaskDraft,
  stripActionItemsSection,
  SEPARATE_TASK_SCOPE,
  type ActionItemsExportContext,
} from './transcriptActionItems.js';
import { createPraxisTask } from './praxisIntegration.js';
import type { ActionItem } from '../types.js';

const MD = '# Transcript\n\n- Date: x\n- Duration: 00:01:00\n\n[00:00:01] [Me] hello\n';
const P = { me: 'Vlad', them: '' };

function item(id: string, text: string, owner: string, source: 'Me' | 'Them' = 'Them'): ActionItem {
  return { id, text, owner, source, createdAt: '2026-01-01T00:00:00.000Z' };
}

const ctx: ActionItemsExportContext = {
  sessionTitle: 'Weekly sync',
  sessionRef: 'Weekly sync (session s1)',
  meetingDate: '2026-02-03',
  participants: P,
  transcript: '[00:00:01] [Me] hello',
  prompt: 'PROMPT',
};

describe('renderActionItemsSection', () => {
  test('maps owners and renders items without owner', () => {
    const out = renderActionItemsSection([item('a', 'Send report', 'Me'), item('b', 'Review', 'Them'), item('c', 'Plain', '')], P);
    expect(out).toBe('## Action items\n\n- **Vlad** — Send report\n- **Them** — Review\n- Plain\n');
  });
  test('empty list gives empty string', () => {
    expect(renderActionItemsSection([], P)).toBe('');
  });
});

describe('upsertActionItemsSection', () => {
  const A = renderActionItemsSection([item('a', 'One', 'Me')], P);
  const B = renderActionItemsSection([item('b', 'Two', '')], P);

  test('appends after the unchanged transcript', () => {
    const out = upsertActionItemsSection(MD, A);
    expect(out.startsWith(MD)).toBe(true);
    expect(out.endsWith(A)).toBe(true);
  });
  test('replaces an existing section', () => {
    expect(upsertActionItemsSection(upsertActionItemsSection(MD, A), B)).toBe(upsertActionItemsSection(MD, B));
  });
  test('removing restores the original', () => {
    expect(upsertActionItemsSection(upsertActionItemsSection(MD, A), '')).toBe(MD);
  });
  test('stripActionItemsSection removes the section', () => {
    expect(stripActionItemsSection(upsertActionItemsSection(MD, A))).toBe(MD);
  });
  test('a line mentioning Action items is not the heading', () => {
    const md = MD + '[00:00:02] [Them] ## Action items are next\n';
    const out = upsertActionItemsSection(md, A);
    expect(out.startsWith(md)).toBe(true);
    expect(upsertActionItemsSection(out, '')).toBe(md);
  });
});

describe('task drafts', () => {
  test('separate draft', () => {
    const d = buildSeparateTaskDraft(item('a', 'Send report', 'Me'), ctx);
    expect(d.title).toBe('Send report');
    expect(d.why).toContain('Owner: Vlad');
    expect(d.why).toContain('Participants: Me = Vlad · Them = Them');
    expect(d.why).toContain('Weekly sync (session s1)');
    expect(d.why).toContain('2026-02-03');
    expect(d.criteria).toBe('- [ ] Send report — Vlad');
    expect(d.why).toContain('## Meeting transcript (context)');
    expect(d.why).toContain('[00:00:01] [Me] hello');
    expect(d.constraints).toBe(SEPARATE_TASK_SCOPE);
    expect(d.constraints).not.toContain('PROMPT');
    expect(d.itemIds).toEqual(['a']);
  });
  test('separate draft without transcript', () => {
    const d = buildSeparateTaskDraft(item('a', 'Send report', 'Me'), { ...ctx, transcript: null });
    expect(d.why.endsWith('Transcript not available yet.')).toBe(true);
  });
  test('common draft', () => {
    const items = [item('a', 'One', 'Me'), item('b', 'Two', 'Them'), item('c', 'Three', 'Bob')];
    const d = buildCommonTaskDraft(items, ctx);
    expect(d.title).toBe('Weekly sync · 2026-02-03');
    const lines = d.criteria.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.startsWith('- [ ] '))).toBe(true);
    expect(lines[0]).toContain('**Vlad**');
    expect(lines[2]).toContain('**Bob**');
    expect(d.itemIds).toEqual(['a', 'b', 'c']);
    expect(d.constraints).toBe('PROMPT');
  });
});

describe('createPraxisTask with drafts', () => {
  let root = '';
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  test('writes separate and common cards', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'august-ai-export-'));
    await fs.mkdir(path.join(root, '.praxis'), { recursive: true });
    const items = [item('a', 'One', 'Me'), item('b', 'Two', 'Them'), item('c', 'Three', '')];
    for (const i of items) {
      const d = buildSeparateTaskDraft(i, ctx);
      await createPraxisTask(root, d.title, d.why, d.criteria, { constraints: d.constraints, labels: ['meeting-action-item'] });
    }
    const newDir = path.join(root, '.praxis', 'tasks', 'new');
    expect(await fs.readdir(newDir)).toHaveLength(3);
    const c = buildCommonTaskDraft(items, ctx);
    const r = await createPraxisTask(root, c.title, c.why, c.criteria, { constraints: c.constraints, labels: ['meeting-action-item'] });
    expect(await fs.readdir(newDir)).toHaveLength(4);
    const task = JSON.parse(await fs.readFile(path.join(newDir, `${r.id}.json`), 'utf-8'));
    expect(task.acceptance_criteria.split('\n').filter((l: string) => l.startsWith('- [ ]'))).toHaveLength(3);
    expect(task.labels).toEqual(['meeting-action-item']);
    expect(task.important_constraints).toBe('PROMPT');
  });
});
