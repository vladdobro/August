import fs from 'node:fs';
import path from 'node:path';

/// Install-folder and data-folder rules for packaged Windows builds (AUG-216).
/// No Electron imports: unit-tested with node:test (installLocation.test.ts). Windows paths are handled with
/// path.win32 so the rules give the same answers on any host.

export const DATA_LOCATION_FILE = 'data-location.json';

export type DataDirSource = 'install-dir' | 'pointer' | 'pointer-missing';

export interface DataDirResolution {
  dataDir: string;
  source: DataDirSource;
  /// Folder named by the pointer, when it held a usable absolute path.
  pointerDir: string | null;
  /// True when the pointer file must be (re)written with dataDir.
  writePointer: boolean;
}

export interface ResolveDataDirInput {
  platform: NodeJS.Platform;
  /// <install dir>\data — the folder used when no pointer applies.
  installDataDir: string;
  /// Raw content of data-location.json, null when the file is missing or unreadable.
  pointerRaw: string | null;
  dirExists: (dir: string) => boolean;
}

/// Pointer content -> absolute Windows folder, or null for anything else (bad JSON, wrong shape, relative path).
export function parseDataLocation(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ''));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const dataDir = (parsed as { dataDir?: unknown }).dataDir;
    if (typeof dataDir !== 'string') return null;
    const trimmed = dataDir.trim();
    return path.win32.isAbsolute(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

export function serializeDataLocation(dataDir: string): string {
  return `${JSON.stringify({ dataDir }, null, 2)}\n`;
}

function sameWindowsPath(a: string, b: string): boolean {
  return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
}

/// Where the Windows data folder is. Rules: no usable pointer -> <install dir>\data (pointer gets written);
/// pointer to an existing folder -> that folder, even when it differs from <install dir>\data;
/// pointer to a missing folder -> <install dir>\data (pointer gets rewritten).
/// Other platforms never use the pointer. Nothing is merged, moved or deleted.
export function resolveDataDir(input: ResolveDataDirInput): DataDirResolution {
  const { platform, installDataDir, pointerRaw, dirExists } = input;
  if (platform !== 'win32') {
    return { dataDir: installDataDir, source: 'install-dir', pointerDir: null, writePointer: false };
  }
  const pointerDir = parseDataLocation(pointerRaw);
  if (pointerDir === null) {
    return { dataDir: installDataDir, source: 'install-dir', pointerDir: null, writePointer: true };
  }
  if (sameWindowsPath(pointerDir, installDataDir)) {
    return { dataDir: installDataDir, source: 'install-dir', pointerDir, writePointer: false };
  }
  if (dirExists(pointerDir)) {
    return { dataDir: pointerDir, source: 'pointer', pointerDir, writePointer: false };
  }
  return { dataDir: installDataDir, source: 'pointer-missing', pointerDir, writePointer: true };
}

export function readDataLocation(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/// UTF-8 JSON written by the app (not by NSIS, whose FileWrite uses the ANSI codepage). Throws on failure.
export function writeDataLocation(file: string, dataDir: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serializeDataLocation(dataDir), 'utf-8');
  fs.renameSync(tmp, file);
}

export function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/// Folder the NSIS updater is told to install into (`/D=`): the folder of the running exe, so an update can
/// never land in another folder. null = leave electron-updater's default (registry InstallLocation).
/// A folder with a space is pinned too: the updater starts the installer with a verbatim command line
/// (see verbatimInstallerSpawn) so `/D=` reaches NSIS unquoted. Only a quote (invalid in Windows paths) is rejected.
export function pinnedInstallDir(platform: NodeJS.Platform, isPackaged: boolean, execPath: string): string | null {
  if (platform !== 'win32' || !isPackaged) return null;
  const dir = path.win32.dirname(execPath);
  return /"/.test(dir) ? null : dir;
}

/// Windows argv quoting as the MS C runtime parses it (same rules as libuv's quote_cmd_arg).
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; }
    else { out += '\\'.repeat(backslashes) + ch; }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

export interface VerbatimSpawn {
  /// Quoted program path; becomes the first token of the raw command line.
  argv0: string;
  /// Already-quoted arguments; the last one is the raw `/D=<dir>`.
  args: string[];
}

/// AUG-217: how to start the NSIS installer (directly or through elevate.exe) so `/D=<dir>` reaches it unquoted.
/// NSIS reads /D= only unquoted and last on the raw command line, and Node quotes any argument with a space.
/// null = spawn normally (not Windows, nothing pinned, last argument is not our /D=, or the dir has no whitespace —
/// then Node does not quote it and the AUG-216 path is unchanged).
export function verbatimInstallerSpawn(platform: NodeJS.Platform, cmd: string, args: readonly string[], installDir: string | null): VerbatimSpawn | null {
  if (platform !== 'win32' || !installDir || args.length === 0) return null;
  const last = args[args.length - 1];
  if (last !== `/D=${installDir}` || !/\s/.test(installDir)) return null;
  return { argv0: quoteWindowsArg(cmd), args: [...args.slice(0, -1).map(quoteWindowsArg), last] };
}

/// The raw command line Windows receives for a VerbatimSpawn (for logs and tests).
export function windowsCommandLine(spawn: VerbatimSpawn): string {
  return [spawn.argv0, ...spawn.args].join(' ');
}
