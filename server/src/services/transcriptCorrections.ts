import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import type { CorrectionItem, CorrectionStatus, CorrectionsFile } from '../types.js';

export type { CorrectionItem, CorrectionStatus, CorrectionsFile };

/// AUG-163: meaning-fix suggestions live next to transcript.md as transcript.corrected.json (suggestions + decisions) and
/// transcript.corrected.md (the original with the ACCEPTED edits applied). transcript.md itself is never written here.
const CORRECTIONS_FILE = 'transcript.corrected.json';
const CORRECTED_MD_FILE = 'transcript.corrected.md';
const TRANSCRIPT_FILE = 'transcript.md';

const TIMESTAMP_LINE = /^\[(\d{2}:\d{2}:\d{2})\] (?:\[(Me|Them)\] )?(.*)$/;

/// Pure. Applies the accepted items of one line in order: each replaces the first occurrence of its `original` (the flagged
/// segment's text) inside `text`; an item whose original is no longer found is skipped.
export function applyItemsToText(text: string, items: CorrectionItem[]): string {
  let out = text;
  for (const item of items) {
    if (item.status !== 'accepted' || !item.original) continue;
    const at = out.indexOf(item.original);
    if (at < 0) continue;
    out = out.slice(0, at) + item.suggested + out.slice(at + item.original.length);
  }
  return out;
}

/// Pure. The k-th timestamp line is utterance k; only the text part of a line changes (applyItemsToText). Header and line
/// endings are preserved.
export function applyCorrections(transcriptMd: string, items: CorrectionItem[]): string {
  const accepted = new Map<number, CorrectionItem[]>();
  for (const item of items) {
    if (item.status !== 'accepted') continue;
    const list = accepted.get(item.index) ?? [];
    list.push(item);
    accepted.set(item.index, list);
  }
  if (accepted.size === 0) return transcriptMd;

  let k = -1;
  return transcriptMd.split('\n').map((line) => {
    const hasCr = line.endsWith('\r');
    const body = hasCr ? line.slice(0, -1) : line;
    const m = TIMESTAMP_LINE.exec(body);
    if (!m) return line;
    k += 1;
    const lineItems = accepted.get(k);
    if (!lineItems) return line;
    const prefix = body.slice(0, body.length - m[3].length);
    return `${prefix}${applyItemsToText(m[3], lineItems)}${hasCr ? '\r' : ''}`;
  }).join('\n');
}

function sessionPath(id: string, name: string): string {
  return path.join(config.sessionsDir, id, name);
}

export async function readCorrections(id: string): Promise<CorrectionsFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionPath(id, CORRECTIONS_FILE), 'utf-8')) as CorrectionsFile;
    return parsed && Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCorrections(id: string, file: CorrectionsFile): Promise<void> {
  await fs.writeFile(sessionPath(id, CORRECTIONS_FILE), JSON.stringify(file, null, 2), 'utf-8');
}

export async function clearCorrections(id: string): Promise<void> {
  await fs.rm(sessionPath(id, CORRECTIONS_FILE), { force: true });
  await fs.rm(sessionPath(id, CORRECTED_MD_FILE), { force: true });
}

/// Writes transcript.corrected.md when at least one item is accepted; otherwise removes it.
export async function writeCorrectedTranscript(id: string): Promise<void> {
  const file = await readCorrections(id);
  const hasAccepted = !!file && file.items.some((i) => i.status === 'accepted');
  if (!file || !hasAccepted) {
    await fs.rm(sessionPath(id, CORRECTED_MD_FILE), { force: true });
    return;
  }
  let md: string;
  try {
    md = await fs.readFile(sessionPath(id, TRANSCRIPT_FILE), 'utf-8');
  } catch {
    return;
  }
  await fs.writeFile(sessionPath(id, CORRECTED_MD_FILE), applyCorrections(md, file.items), 'utf-8');
}

/// Returns the updated file, or null when the file or the item does not exist.
export async function setCorrectionStatus(id: string, itemId: number, status: CorrectionStatus): Promise<CorrectionsFile | null> {
  const file = await readCorrections(id);
  const item = file?.items.find((i) => i.id === itemId);
  if (!file || !item) return null;
  item.status = status;
  await writeCorrections(id, file);
  await writeCorrectedTranscript(id);
  return file;
}

/// AUG-163: sets every pending item to `status` in one write (Accept all); returns the updated file, or null when there is no file.
export async function setAllPendingStatus(id: string, status: CorrectionStatus): Promise<CorrectionsFile | null> {
  const file = await readCorrections(id);
  if (!file) return null;
  for (const item of file.items) if (item.status === 'pending') item.status = status;
  await writeCorrections(id, file);
  await writeCorrectedTranscript(id);
  return file;
}
