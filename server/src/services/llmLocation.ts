import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  config,
  defaultLlmRoot,
  LLAMA_CPP_BUILDS,
  LLM_LOCATION_FILE_NAME,
  LLM_MODELS,
  LLM_ROOT_SUBFOLDER,
  type LlmVariantDir,
} from '../config.js';
import { llamaBuildInstalled } from './llmPaths.js';
import { getLlmDownloadStatus, setLlmDownloadStatus } from './llmStatus.js';

/// User-chosen folder for the local language model files (engine + models), AUG-162 follow-up. Everything the model
/// needs lives under config.llmRoot; this module decides where that is, checks it is usable and moves the files when
/// the user picks another folder. It must not import llmServer / llmInstaller (they import this module).
export const LLM_LOCATION_UNAVAILABLE_MESSAGE = 'The model folder is not available. Connect the drive or choose another folder.';

const SPACE_MARGIN_BYTES = 200e6;

let relocating = false;

export function isLlmRelocating(): boolean {
  return relocating;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/// Root usable = it exists as a directory, or its parent directory exists (so it can be created). False on a missing drive/parent.
/// The default root is always usable: its parent is the app data dir, which the server creates itself.
export async function llmLocationAvailable(root: string = config.llmRoot): Promise<boolean> {
  if (path.resolve(root) === defaultLlmRoot()) return true;
  if (await isDirectory(root)) return true;
  return isDirectory(path.dirname(root));
}

/// Free bytes on the volume holding `root` (nearest existing ancestor) via fs.statfs (bavail * bsize); null when unknown.
export async function freeBytesAt(root: string): Promise<number | null> {
  let dir = path.resolve(root);
  for (;;) {
    if (await isDirectory(dir)) break;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  try {
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/// Pure: the root a picked folder maps to. null → default root; otherwise <picked>/August LLM.
export function targetRootFor(picked: string | null, dataDir: string): string {
  if (picked === null) return path.join(dataDir, 'llm');
  return path.join(path.resolve(picked), LLM_ROOT_SUBFOLDER);
}

/// Pure validation, returns an error message or null. The same path (no-op) is allowed here — the caller handles it.
/// Compared with the path flavour of `platform` (case-insensitive on win32) so it is deterministic on any host OS.
export function validateRelocation(current: string, target: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(target)) return 'Choose a full folder path.';
  const norm = (value: string) => {
    const resolved = p.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const a = norm(current);
  const b = norm(target);
  if (a === b) return null;
  const inside = (outer: string, inner: string) => {
    const rel = p.relative(outer, inner);
    return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
  };
  if (inside(a, b)) return 'Choose a folder outside the current model folder.';
  if (inside(b, a)) return 'Choose a folder that does not contain the current model folder.';
  return null;
}

/// Remembers the root across restarts and app updates (the data dir survives both). null / the default root → file removed.
export async function writeLlmLocation(root: string | null): Promise<void> {
  const file = path.join(config.dataDir, LLM_LOCATION_FILE_NAME);
  if (root === null || path.resolve(root) === defaultLlmRoot()) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ root: path.resolve(root) }, null, 2), 'utf-8');
}

export interface LlmLocationStatus {
  root: string;
  isDefault: boolean;
  pinned: boolean;
  available: boolean;
  freeBytes: number | null;
}

export async function getLlmLocationStatus(): Promise<LlmLocationStatus> {
  const available = await llmLocationAvailable();
  return {
    root: config.llmRoot,
    isDefault: path.resolve(config.llmRoot) === defaultLlmRoot(),
    pinned: config.llmRootPinned,
    available,
    freeBytes: available ? await freeBytesAt(config.llmRoot) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Moving the files

/// Leftovers of interrupted downloads / extractions — deleted instead of moved.
function isJunkEntry(name: string): boolean {
  return name.endsWith('.part') || name.startsWith('.extract-');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/// Recursive size in bytes (lstat; symlinks count 0).
async function treeSize(p: string): Promise<number> {
  const st = await fs.lstat(p);
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of await fs.readdir(p)) total += await treeSize(path.join(p, name));
  return total;
}

interface MoveUnit {
  src: string;
  dst: string;
}

interface MoveProgress {
  total: number;
  done: number;
  lastPercent: number;
}

function reportProgress(progress: MoveProgress, force = false): void {
  const percent = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  if (!force && percent - progress.lastPercent < 0.5) return;
  progress.lastPercent = percent;
  setLlmDownloadStatus({ downloading: true, phase: 'moving', percent, bytesDownloaded: progress.done, totalBytes: progress.total, verifying: false, error: null });
}

/// Copies a tree with per-file streaming (each file lands as <file>.moving, then is renamed). Symlinks are recreated
/// on non-Windows (macOS dylib links must survive); file modes are preserved there too.
async function copyTree(src: string, dst: string, progress: MoveProgress): Promise<void> {
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) {
    if (process.platform !== 'win32') await fs.symlink(await fs.readlink(src), dst);
    return;
  }
  if (st.isDirectory()) {
    await fs.mkdir(dst, { recursive: true });
    for (const name of await fs.readdir(src)) await copyTree(path.join(src, name), path.join(dst, name), progress);
    return;
  }
  if (!st.isFile()) return;
  const tmp = `${dst}.moving`;
  const input = createReadStream(src);
  input.on('data', (chunk) => {
    progress.done += chunk.length;
    reportProgress(progress);
  });
  await pipeline(input, createWriteStream(tmp));
  if (process.platform !== 'win32') await fs.chmod(tmp, st.mode);
  await fs.rename(tmp, dst);
}

/// Every regular file under src exists under dst with the same size.
async function verifyCopy(src: string, dst: string): Promise<void> {
  const st = await fs.lstat(src);
  if (st.isDirectory()) {
    for (const name of await fs.readdir(src)) await verifyCopy(path.join(src, name), path.join(dst, name));
    return;
  }
  if (!st.isFile()) return;
  const copied = await fs.stat(dst).catch(() => null);
  if (!copied || copied.size !== st.size) throw new Error(`${path.basename(dst)} was not copied completely`);
}

function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/// Lists what to move from <current>/bin and <current>/models into <target>. Junk is deleted in place. A unit whose
/// destination already holds a complete copy is dropped from the moves and listed in `redundant` (source removed at the end).
async function planMoves(current: string, target: string): Promise<{ moves: MoveUnit[]; redundant: string[] }> {
  const moves: MoveUnit[] = [];
  const redundant: string[] = [];

  for (const top of ['bin', 'models'] as const) {
    const srcTop = path.join(current, top);
    if (!(await exists(srcTop))) continue;
    const dstTop = path.join(target, top);
    if (!(await exists(dstTop))) {
      for (const name of await fs.readdir(srcTop)) {
        if (isJunkEntry(name)) await fs.rm(path.join(srcTop, name), { recursive: true, force: true });
      }
      moves.push({ src: srcTop, dst: dstTop });
      continue;
    }
    // The target already has this folder: merge per child.
    for (const name of await fs.readdir(srcTop)) {
      const src = path.join(srcTop, name);
      if (isJunkEntry(name)) {
        await fs.rm(src, { recursive: true, force: true });
        continue;
      }
      const dst = path.join(dstTop, name);
      if (!(await exists(dst))) {
        moves.push({ src, dst });
        continue;
      }
      let keepTarget = false;
      if (top === 'models') {
        const spec = LLM_MODELS.find((m) => m.fileName === name);
        const st = await fs.stat(dst).catch(() => null);
        keepTarget = !!spec && !!st && st.isFile() && st.size === spec.sizeBytes;
      } else if (name in LLAMA_CPP_BUILDS) {
        keepTarget = await llamaBuildInstalled(target, name as LlmVariantDir);
      }
      if (keepTarget) {
        redundant.push(src);
      } else {
        await fs.rm(dst, { recursive: true, force: true });
        moves.push({ src, dst });
      }
    }
  }
  return { moves, redundant };
}

/// Moves the local LLM files to `target` (a full root, e.g. <picked>/August LLM or the default). Same volume: rename;
/// other volume: copy with progress, verify sizes, then delete the source. The location file is written, and
/// config.llmRoot switched, only after everything moved; on failure the old root stays active and this call's
/// partial results at the target are undone. Throws Error with a user-safe message. llama-server must be stopped
/// by the caller first.
export async function relocateLlmRoot(target: string): Promise<void> {
  if (config.llmRootPinned) throw new Error('The model folder is set by system configuration.');
  if (relocating) throw new Error('The model files are already being moved.');
  if (getLlmDownloadStatus().downloading) throw new Error('Wait for the download to finish, then change the folder.');
  const current = config.llmRoot;
  const invalid = validateRelocation(current, target);
  if (invalid) throw new Error(invalid);
  if (path.resolve(target) === path.resolve(current)) return;

  relocating = true;
  setLlmDownloadStatus({ downloading: true, phase: 'moving', percent: 0, bytesDownloaded: 0, totalBytes: 0, verifying: false, error: null });

  // Undo log for the failure path: renamed units go back, copied units are removed from the target.
  const renamed: MoveUnit[] = [];
  const copied: MoveUnit[] = [];
  let createdTargetRoot = false;
  try {
    createdTargetRoot = !(await exists(target));
    try {
      await fs.mkdir(target, { recursive: true });
      const probe = path.join(target, '.write-test');
      await fs.writeFile(probe, 'ok');
      await fs.unlink(probe);
    } catch {
      throw new Error('Cannot write to the chosen folder.');
    }

    const { moves, redundant } = await planMoves(current, target);

    // Same volume → instant rename; anything that cannot be renamed across volumes is queued for copying.
    const toCopy: MoveUnit[] = [];
    for (const unit of moves) {
      await fs.mkdir(path.dirname(unit.dst), { recursive: true });
      try {
        await fs.rename(unit.src, unit.dst);
        renamed.push(unit);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') toCopy.push(unit);
        else throw err;
      }
    }

    if (toCopy.length > 0) {
      let total = 0;
      for (const unit of toCopy) total += await treeSize(unit.src);
      const free = await freeBytesAt(target);
      if (free !== null && free < total + SPACE_MARGIN_BYTES) {
        throw new Error(`Not enough free space in the chosen folder (needs ${formatGb(total + SPACE_MARGIN_BYTES)}).`);
      }
      const progress: MoveProgress = { total, done: 0, lastPercent: -1 };
      reportProgress(progress, true);
      for (const unit of toCopy) {
        copied.push(unit);
        await copyTree(unit.src, unit.dst, progress);
      }
      setLlmDownloadStatus({ verifying: true });
      for (const unit of toCopy) await verifyCopy(unit.src, unit.dst);
      setLlmDownloadStatus({ verifying: false });
    }

    await writeLlmLocation(path.resolve(target) === defaultLlmRoot() ? null : target);
    config.llmRoot = target;

    // Past the point of no return: the sources of copied units and redundant duplicates are no longer needed.
    for (const unit of toCopy) await fs.rm(unit.src, { recursive: true, force: true }).catch(() => {});
    for (const src of redundant) await fs.rm(src, { recursive: true, force: true }).catch(() => {});
    // Only an empty old root is removed; anything else in it stays untouched.
    for (const top of ['bin', 'models']) await fs.rmdir(path.join(current, top)).catch(() => {});
    await fs.rmdir(current).catch(() => {});

    setLlmDownloadStatus({ downloading: false, phase: null, percent: 0, bytesDownloaded: 0, totalBytes: 0, verifying: false, error: null });
  } catch (err) {
    for (const unit of renamed) await fs.rename(unit.dst, unit.src).catch(() => {});
    for (const unit of copied) await fs.rm(unit.dst, { recursive: true, force: true }).catch(() => {});
    if (createdTargetRoot) {
      for (const top of ['bin', 'models']) await fs.rmdir(path.join(target, top)).catch(() => {});
      await fs.rmdir(target).catch(() => {});
    }
    const message = (err as Error)?.message || String(err);
    console.error('[llm] moving model files failed:', err);
    setLlmDownloadStatus({ downloading: false, phase: null, verifying: false, error: `Moving the model files failed: ${message}` });
    throw err instanceof Error ? err : new Error(message);
  } finally {
    relocating = false;
  }
}
