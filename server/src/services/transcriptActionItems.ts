/// AUG-166: keeps a trailing "## Action items" section in transcript.md and builds Praxis card drafts from action items.

import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import type { ActionItem, ActionItemsFile, Participants } from '../types.js';
import { writeCorrectedTranscript } from './transcriptCorrections.js';

export const ACTION_ITEMS_HEADING = '## Action items';

/// 'Me' / 'Them' -> participant names (same rule as the client displayOwner).
export function ownerLabel(owner: string, p: Participants): string {
  if (owner === 'Me') return p.me || 'Me';
  if (owner === 'Them') return p.them || 'Them';
  return owner;
}

export function participantsLine(p: Participants): string {
  return `Me = ${p.me || 'Me'} · Them = ${p.them || 'Them'}`;
}

/// One line per item: `- **Owner** — text`, or `- text` when there is no owner.
export function renderActionItemsSection(items: ActionItem[], p: Participants): string {
  if (items.length === 0) return '';
  const lines = items.map((i) => {
    const owner = ownerLabel(i.owner, p);
    return owner ? `- **${owner}** — ${i.text}` : `- ${i.text}`;
  });
  return `${ACTION_ITEMS_HEADING}\n\n${lines.join('\n')}\n`;
}

/// Replaces (or appends, or removes when `section` is '') the trailing Action items section; everything before it stays byte-identical.
export function upsertActionItemsSection(markdown: string, section: string): string {
  let idx = -1;
  for (const m of markdown.matchAll(/^## Action items[ \t]*\r?$/gm)) idx = m.index ?? idx;
  let base = idx >= 0 ? markdown.slice(0, idx) : markdown;
  if (idx >= 0 && base.endsWith('\n\n')) base = base.slice(0, -1);
  if (section === '') return base;
  return base + (base.endsWith('\n') || base === '' ? '' : '\n') + '\n' + section;
}

/// Transcript text without the trailing Action items section.
export function stripActionItemsSection(markdown: string): string {
  return upsertActionItemsSection(markdown, '');
}

export const SEPARATE_TASK_SCOPE = 'Scope: this one action item. The meeting transcript in the description is background context only — do not create tasks for anything else in it.';

export interface ActionItemsExportContext {
  sessionTitle: string; // session.title, or 'Live recording' for a live one
  sessionRef: string; // `${session.title} (session ${session.id})` or `live recording in progress (key ${liveKey})`
  meetingDate: string; // YYYY-MM-DD
  participants: Participants;
  transcript: string | null; // separate cards: whole conversation, attached as context
  prompt: string; // resolved prompt with variables applied (common card only)
}

export interface TaskDraft { title: string; why: string; criteria: string; constraints: string; itemIds: string[] }

export function buildSeparateTaskDraft(item: ActionItem, ctx: ActionItemsExportContext): TaskDraft {
  const p = ctx.participants;
  const owner = ownerLabel(item.owner, p);
  const why = [
    `Action item from the meeting "${ctx.sessionTitle}" on ${ctx.meetingDate}.`,
    '',
    `- Owner: ${owner || 'not set'}`,
    `- Participants: ${participantsLine(p)}`,
    `- Said by: ${ownerLabel(item.source, p)}`,
    `- Session: ${ctx.sessionRef}`,
    `- Meeting date: ${ctx.meetingDate}`,
    '',
    '## Meeting transcript (context)',
    '',
    ctx.transcript?.trim() || 'Transcript not available yet.',
  ].join('\n');
  return {
    title: item.text.trim().slice(0, 200),
    why,
    criteria: `- [ ] ${item.text}${owner ? ` — ${owner}` : ''}`,
    constraints: SEPARATE_TASK_SCOPE,
    itemIds: [item.id],
  };
}

export function buildCommonTaskDraft(items: ActionItem[], ctx: ActionItemsExportContext): TaskDraft {
  const p = ctx.participants;
  const why = [
    `Action items from the meeting "${ctx.sessionTitle}" on ${ctx.meetingDate}.`,
    '',
    `- Participants: ${participantsLine(p)}`,
    `- Session: ${ctx.sessionRef}`,
    `- Meeting date: ${ctx.meetingDate}`,
  ].join('\n');
  const criteria = items
    .map((i) => {
      const owner = ownerLabel(i.owner, p);
      return owner ? `- [ ] **${owner}** — ${i.text}` : `- [ ] ${i.text}`;
    })
    .join('\n');
  return {
    title: `${ctx.sessionTitle} · ${ctx.meetingDate}`,
    why,
    criteria,
    constraints: ctx.prompt,
    itemIds: items.map((i) => i.id),
  };
}

const locks = new Map<string, Promise<unknown>>();

function withTranscriptLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(id, run);
  const cleanup = () => { if (locks.get(id) === run) locks.delete(id); };
  run.then(cleanup, cleanup);
  return run;
}

function transcriptPath(id: string): string {
  return path.join(config.sessionsDir, id, 'transcript.md');
}

async function writeAtomic(p: string, content: string): Promise<void> {
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, p);
}

const NO_PARTICIPANTS: Participants = { me: '', them: '' };

/// Rewrites the section of an existing transcript.md; no-op when there is no transcript yet (it gets the section when transcription writes it).
export function syncTranscriptActionItems(sessionId: string, file: ActionItemsFile | null): Promise<void> {
  return withTranscriptLock(sessionId, async () => {
    const p = transcriptPath(sessionId);
    let md: string;
    try {
      md = await fs.readFile(p, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }
    const next = upsertActionItemsSection(md, renderActionItemsSection(file?.items ?? [], file?.participants ?? NO_PARTICIPANTS));
    if (next === md) return;
    await writeAtomic(p, next);
    await writeCorrectedTranscript(sessionId);
  });
}

/// Transcription path: writes a fresh transcript.md with the session's current section in one write. `loadItems` runs inside the lock.
export function writeTranscriptWithActionItems(
  sessionId: string,
  transcript: string,
  loadItems: () => Promise<ActionItemsFile | null>,
): Promise<void> {
  return withTranscriptLock(sessionId, async () => {
    const file = await loadItems().catch(() => null);
    const p = transcriptPath(sessionId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await writeAtomic(p, upsertActionItemsSection(transcript, renderActionItemsSection(file?.items ?? [], file?.participants ?? NO_PARTICIPANTS)));
  });
}
