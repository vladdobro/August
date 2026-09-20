import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { fileExists } from './whisper.js';

/// WASAPI loopback helper lifecycle (AUG-112). The helper is a single C# 5
/// file (server/tools/wasapi-loopback/WasapiLoopback.cs) compiled on demand
/// with the csc.exe that ships inside .NET Framework 4.x on every Windows
/// 10/11 machine — no SDK, no NuGet, no network. The compiled exe and a
/// sha256 of the source it was built from live in config.toolsDir; a source
/// change triggers a rebuild on the next probe. `--probe` reports the default
/// output device's mix format so ffmpeg can be told what the raw stream is.

export interface WasapiProbe {
  sampleRate: number;
  channels: number;
  format: string;
  bitsPerSample: number;
  device: string;
}

export type WasapiHelperStatus =
  | { ok: true; exePath: string; probe: WasapiProbe }
  | { ok: false; reason: string };

const SUPPORTED_FORMATS = new Set(['u8', 's16le', 's24le', 's32le', 'f32le', 'f64le']);
const COMPILE_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const OUTPUT_EXCERPT_CHARS = 300;
const HELPER_EXIT_NO_DEVICE = 2;

export function parseWasapiProbe(stdout: string): WasapiProbe | null {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('{'));
  if (!line) return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sampleRate = o.sampleRate;
  const channels = o.channels;
  const format = o.format;
  const bitsPerSample = o.bitsPerSample;
  const device = o.device;
  if (!Number.isInteger(sampleRate) || (sampleRate as number) <= 0) return null;
  if (!Number.isInteger(channels) || (channels as number) <= 0) return null;
  if (typeof format !== 'string' || !SUPPORTED_FORMATS.has(format)) return null;
  if (!Number.isInteger(bitsPerSample) || (bitsPerSample as number) <= 0) return null;
  if (typeof device !== 'string') return null;
  return { sampleRate: sampleRate as number, channels: channels as number, format, bitsPerSample: bitsPerSample as number, device };
}

export function helperPaths(): { sourcePath: string; exePath: string; hashPath: string } {
  return {
    sourcePath: config.wasapiHelperSourcePath,
    exePath: path.join(config.toolsDir, 'wasapi-loopback.exe'),
    hashPath: path.join(config.toolsDir, 'wasapi-loopback.sha256'),
  };
}

function cscCandidates(): string[] {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return [
    path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
}

async function findCsc(): Promise<string | null> {
  for (const candidate of cscCandidates()) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function excerpt(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > OUTPUT_EXCERPT_CHARS ? `${trimmed.slice(0, OUTPUT_EXCERPT_CHARS)}…` : trimmed;
}

/// Compiles the helper when the exe is missing or the source hash changed.
export async function ensureWasapiHelper(): Promise<{ ok: true; exePath: string; compiled: boolean } | { ok: false; reason: string }> {
  if (process.platform !== 'win32') return { ok: false, reason: 'WASAPI helper is Windows-only' };
  const { sourcePath, exePath, hashPath } = helperPaths();
  if (!(await fileExists(sourcePath))) return { ok: false, reason: `helper source missing at ${sourcePath}` };
  const hash = await sha256File(sourcePath);
  const builtFrom = (await fs.readFile(hashPath, 'utf-8').catch(() => '')).trim();
  if (builtFrom === hash && (await fileExists(exePath))) return { ok: true, exePath, compiled: false };

  const csc = await findCsc();
  if (!csc) return { ok: false, reason: 'csc.exe (.NET Framework 4.x) not found under %SystemRoot%\\Microsoft.NET — cannot build the WASAPI helper' };
  await fs.mkdir(config.toolsDir, { recursive: true });
  const result = await new Promise<{ error: Error | null; output: string }>((resolve) => {
    execFile(
      csc,
      ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${exePath}`, sourcePath],
      { timeout: COMPILE_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, output: `${stdout ?? ''}${stderr ?? ''}` }),
    );
  });
  if (result.error || !(await fileExists(exePath))) {
    return { ok: false, reason: `csc failed: ${excerpt(result.output) || result.error?.message || 'unknown error'}` };
  }
  await fs.writeFile(hashPath, hash, 'utf-8');
  console.log(`Compiled WASAPI loopback helper → ${exePath}`);
  return { ok: true, exePath, compiled: true };
}

export async function probeWasapiHelper(exePath: string): Promise<{ ok: true; probe: WasapiProbe } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    execFile(exePath, ['--probe'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // execFile reports the exit status as error.code (a number), while spawn failures use a string code such as ENOENT.
        const code: unknown = (error as { code?: unknown }).code;
        if (code === HELPER_EXIT_NO_DEVICE) { resolve({ ok: false, reason: 'no default output device (nothing selected in Sound settings > Output)' }); return; }
        resolve({ ok: false, reason: `helper probe failed: ${excerpt(stderr ?? '') || error.message}` });
        return;
      }
      const probe = parseWasapiProbe(stdout ?? '');
      if (!probe) { resolve({ ok: false, reason: `helper probe printed an unreadable format line: ${excerpt(stdout ?? '')}` }); return; }
      resolve({ ok: true, probe });
    });
  });
}

/// Build (if needed) and probe in one call; this is what the capability probe uses.
export async function getWasapiHelperStatus(): Promise<WasapiHelperStatus> {
  const built = await ensureWasapiHelper();
  if (!built.ok) return built;
  const probed = await probeWasapiHelper(built.exePath);
  if (!probed.ok) return { ok: false, reason: probed.reason };
  return { ok: true, exePath: built.exePath, probe: probed.probe };
}
