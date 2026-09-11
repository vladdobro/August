import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { config } from '../config.js';
import type { SessionMetadata, SessionStatus, TranscriptionLanguage } from '../types.js';

const SESSION_FILE = 'session.json';
const TRANSCRIPT_FILE = 'transcript.md';

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

/// Status helper kept alongside updateSession for callers that only need to
/// flip the status field (with an optional error message on failure).
export async function setStatus(
  id: string,
  status: SessionStatus,
  error?: string,
): Promise<void> {
  await updateSession(id, { status, ...(error !== undefined ? { error } : {}) });
}
