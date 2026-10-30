import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { config } from '../config.js';
import type {
  SessionMetadata,
  SessionSource,
  SessionStatus,
  SessionStorageEntry,
  SessionStorageFile,
  StorageFileKind,
  StorageSummary,
  TranscriptionLanguage,
} from '../types.js';
import { isPlatformUrl } from './ytDlp.js';

const SESSION_FILE = 'session.json';
const TRANSCRIPT_FILE = 'transcript.md';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/// Matches source audio (audio.webm, audio-mic.webm, audio-system.wav), the derived audio.wav and
/// the *-boosted.wav / *-partial.wav intermediates.
export const AUDIO_FILE_PATTERN = /^audio(-mic|-system)?[.-]/;

/// Guards ids that come from the URL before they reach the filesystem (Archive page, AUG-150).
export function isValidSessionId(id: string): boolean {
  if (!SESSION_ID_PATTERN.test(id)) return false;
  return path.dirname(path.resolve(config.sessionsDir, id)) === path.resolve(config.sessionsDir);
}

function sessionDir(id: string): string {
  return path.join(config.sessionsDir, id);
}

function sessionFilePath(id: string): string {
  return path.join(sessionDir(id), SESSION_FILE);
}

function transcriptFilePath(id: string): string {
  return path.join(sessionDir(id), TRANSCRIPT_FILE);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readSessionFile(id: string): Promise<SessionMetadata | null> {
  try {
    const raw = await fs.readFile(sessionFilePath(id), 'utf-8');
    return JSON.parse(raw) as SessionMetadata;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeSessionFile(session: SessionMetadata): Promise<void> {
  await fs.writeFile(sessionFilePath(session.id), JSON.stringify(session, null, 2), 'utf-8');
}

/// Creates a new session directory under config.sessionsDir with a fresh
/// UUID id, writes the initial session.json, and returns the metadata. The
/// caller is expected to place the uploaded/recorded audio file inside the
/// returned session's directory (see sessionAudioDir) and then drive the
/// session through the transcribing -> completed/failed lifecycle via
/// updateSession.
export async function createSession(
  originalFileName: string | undefined,
  language: TranscriptionLanguage,
  dualTrack?: boolean,
): Promise<SessionMetadata> {
  const id = uuidv4();
  const dir = sessionDir(id);
  await ensureDir(dir);

  const title = originalFileName?.trim()
    ? originalFileName
    : `Recording ${new Date().toLocaleString()}`;

  const session: SessionMetadata = {
    id,
    title,
    createdAt: new Date().toISOString(),
    duration: 0,
    language,
    status: 'uploading',
    originalFileName,
    ...(dualTrack ? { dualTrack: true } : {}),
  };

  await writeSessionFile(session);
  return session;
}

export function sessionAudioDir(id: string): string {
  return sessionDir(id);
}

export async function getSession(id: string): Promise<SessionMetadata | null> {
  return readSessionFile(id);
}

export async function listSessions(): Promise<SessionMetadata[]> {
  await ensureDir(config.sessionsDir);
  const entries = await fs.readdir(config.sessionsDir, { withFileTypes: true });
  const sessions: SessionMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const session = await readSessionFile(entry.name);
    if (session) sessions.push(session);
  }

  sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return sessions;
}

export async function updateSession(
  id: string,
  updates: Partial<Omit<SessionMetadata, 'id'>>,
): Promise<SessionMetadata | null> {
  const existing = await readSessionFile(id);
  if (!existing) return null;

  const updated: SessionMetadata = { ...existing, ...updates };
  await writeSessionFile(updated);
  return updated;
}

export async function getTranscript(id: string): Promise<string | null> {
  try {
    return await fs.readFile(transcriptFilePath(id), 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeTranscript(id: string, content: string): Promise<void> {
  await fs.writeFile(transcriptFilePath(id), content, 'utf-8');
}

export async function deleteSession(id: string): Promise<void> {
  await fs.rm(sessionDir(id), { recursive: true, force: true });
}

async function dirSize(p: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(p, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(p, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSize(full);
      else total += (await fs.stat(full)).size;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return total;
}

const KIND_ORDER: Record<StorageFileKind, number> = { audio: 0, transcript: 1, meta: 2, other: 3 };

/// Sizes every file in a session directory for the Archive page (AUG-150). Files recorded in
/// audioDeletedFiles are listed as deleted; they count towards neither totalBytes nor audioBytes.
export async function getSessionStorage(session: SessionMetadata): Promise<SessionStorageEntry> {
  const dir = sessionDir(session.id);
  let dirEntries: import('node:fs').Dirent[] = [];
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const files: SessionStorageFile[] = [];
  for (const entry of dirEntries) {
    const full = path.join(dir, entry.name);
    let bytes = 0;
    try {
      bytes = entry.isDirectory() ? await dirSize(full) : (await fs.stat(full)).size;
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    let kind: StorageFileKind = 'other';
    if (AUDIO_FILE_PATTERN.test(entry.name)) kind = 'audio';
    else if (entry.name === TRANSCRIPT_FILE || entry.name === 'transcript.corrected.md' || entry.name === 'transcript.corrected.json') kind = 'transcript';
    else if (entry.name === SESSION_FILE) kind = 'meta';
    files.push({ name: entry.name, bytes, kind });
  }

  const audioNames = files.filter((f) => f.kind === 'audio').map((f) => f.name);
  for (const file of files) {
    if (file.kind !== 'audio') continue;
    const ext = path.extname(file.name);
    if (file.name.includes('-boosted')) {
      file.note = 'boosted';
    } else if (
      ext.toLowerCase() === '.wav' &&
      audioNames.some((other) => other !== file.name && path.basename(other, path.extname(other)) === path.basename(file.name, ext) && path.extname(other).toLowerCase() !== '.wav')
    ) {
      file.note = 'converted';
    } else {
      file.note = 'original';
    }
  }

  const onDisk = new Set(files.map((f) => f.name));
  for (const gone of session.audioDeletedFiles ?? []) {
    if (onDisk.has(gone.name)) continue;
    files.push({ name: gone.name, bytes: gone.bytes, kind: 'audio', deleted: true, ...(gone.auto ? { auto: true } : {}) });
  }

  files.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));

  const live = files.filter((f) => !f.deleted);
  const totalBytes = live.reduce((sum, f) => sum + f.bytes, 0);
  const audioBytes = live.filter((f) => f.kind === 'audio').reduce((sum, f) => sum + f.bytes, 0);

  let source: SessionSource;
  if (session.sourceUrl) {
    source = isPlatformUrl(session.sourceUrl) ? 'platform' : 'link';
  } else if (
    session.dualTrack ||
    !session.originalFileName ||
    session.originalFileName.startsWith('recording-') ||
    session.originalFileName.startsWith('recovered-')
  ) {
    source = 'recording';
  } else {
    source = 'upload';
  }

  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    status: session.status,
    source,
    ...(session.sourceUrl ? { sourceUrl: session.sourceUrl } : {}),
    ...(session.error ? { error: session.error } : {}),
    totalBytes,
    audioBytes,
    audioDeleted: !!session.audioDeletedAt,
    wavAutoDeleted: files.some((f) => f.deleted && f.auto === true),
    files,
  };
}

/// Per-session disk usage for the whole sessions dir (Archive page, AUG-150).
export async function listStorage(): Promise<StorageSummary> {
  const sessions = await listSessions();
  const entries = await Promise.all(sessions.map((s) => getSessionStorage(s)));
  return {
    sessionsDir: config.sessionsDir,
    totalBytes: entries.reduce((sum, e) => sum + e.totalBytes, 0),
    sessions: entries,
  };
}

/// Removes audio files from a session (all of them, or the single `fileName`), keeping transcript.md and
/// session.json. Names and sizes are remembered in audioDeletedFiles; audioDeletedAt is set once no audio is left.
export async function deleteSessionAudio(
  id: string,
  fileName?: string,
): Promise<{ session: SessionMetadata; freedBytes: number } | null> {
  const session = await readSessionFile(id);
  if (!session) return null;

  const dir = sessionDir(id);
  const dirEntries = await fs.readdir(dir, { withFileTypes: true });
  const candidates = dirEntries.filter((e) => e.isFile() && AUDIO_FILE_PATTERN.test(e.name)).map((e) => e.name);

  let targets = candidates;
  if (fileName !== undefined) {
    if (fileName !== path.basename(fileName) || !AUDIO_FILE_PATTERN.test(fileName) || !candidates.includes(fileName)) {
      throw new Error('Not an audio file of this session');
    }
    targets = [fileName];
  }

  let freedBytes = 0;
  const removed: Array<{ name: string; bytes: number }> = [];
  for (const name of targets) {
    const full = path.join(dir, name);
    let bytes = 0;
    try {
      bytes = (await fs.stat(full)).size;
    } catch {
      // already gone
    }
    await fs.rm(full, { force: true });
    freedBytes += bytes;
    removed.push({ name, bytes });
  }

  const removedNames = new Set(removed.map((r) => r.name));
  const audioDeletedFiles = [
    ...(session.audioDeletedFiles ?? []).filter((f) => !removedNames.has(f.name)),
    ...removed,
  ];
  const remaining = candidates.filter((n) => !removedNames.has(n));
  const updated = await updateSession(id, {
    audioDeletedFiles,
    ...(remaining.length === 0 ? { audioDeletedAt: new Date().toISOString() } : {}),
  });
  return { session: updated ?? session, freedBytes };
}

/// AUG-152: removes the converted WAVs of a session after a confident transcription — only a `*.wav` that has a
/// non-WAV source next to it (audio.webm → audio.wav, audio-mic.webm → audio-mic.wav). A WAV that *is* the source
/// (direct .wav upload, server-captured audio-system.wav) is never touched, so ensureWav can always rebuild what was
/// removed. Boosted/partial intermediates are skipped. Removed files are remembered in audioDeletedFiles with auto: true
/// and wavAutoDeletedAt is set; audioDeletedAt (all audio gone) is deliberately NOT set.
export async function autoDeleteDerivedWavs(id: string): Promise<{ removed: Array<{ name: string; bytes: number }>; freedBytes: number } | null> {
  const session = await readSessionFile(id);
  if (!session) return null;
  const dir = sessionDir(id);
  const names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  const removed: Array<{ name: string; bytes: number }> = [];
  for (const name of names) {
    if (!AUDIO_FILE_PATTERN.test(name)) continue;
    if (path.extname(name).toLowerCase() !== '.wav') continue;
    if (name.includes('-boosted') || name.includes('-partial')) continue;
    const base = path.basename(name, path.extname(name));
    const hasSource = names.some((other) => other !== name && path.basename(other, path.extname(other)) === base && path.extname(other).toLowerCase() !== '.wav');
    if (!hasSource) continue;
    const full = path.join(dir, name);
    let bytes = 0;
    try { bytes = (await fs.stat(full)).size; } catch { /* already gone */ }
    await fs.rm(full, { force: true });
    removed.push({ name, bytes });
  }
  if (removed.length === 0) return { removed, freedBytes: 0 };
  const removedNames = new Set(removed.map((r) => r.name));
  const audioDeletedFiles = [
    ...(session.audioDeletedFiles ?? []).filter((f) => !removedNames.has(f.name)),
    ...removed.map((r) => ({ ...r, auto: true })),
  ];
  await updateSession(id, { audioDeletedFiles, wavAutoDeletedAt: new Date().toISOString() });
  return { removed, freedBytes: removed.reduce((sum, r) => sum + r.bytes, 0) };
}

/// Status helper kept alongside updateSession for callers that only need to
/// flip the status field (with an optional error message on failure).
export async function setStatus(
  id: string,
  status: SessionStatus,
  error?: string,
): Promise<void> {
  await updateSession(id, { status, ...(error !== undefined ? { error } : {}) });
}
