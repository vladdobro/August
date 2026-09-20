import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { checkFfmpegAvailable, fileExists, getAudioDuration } from './whisper.js';
import { resolveAudioteeSampleFormat, SAMPLE_FORMAT_PROBE_BYTES } from './pcmSampleFormat.js';
import { getWasapiHelperStatus, type WasapiHelperStatus, type WasapiProbe } from './wasapiHelper.js';
import type { CaptureCapabilities, CaptureMethod, CaptureSelfTest } from '../types.js';

/// Server-side system audio capture (AUG-105). The browser client can never
/// receive system audio without the getDisplayMedia() picker, so on macOS the
/// server captures it instead: either through the `audiotee` Core Audio tap
/// CLI (macOS 14.2+, no virtual device needed) piped into ffmpeg, or by
/// reading a BlackHole loopback device through ffmpeg's avfoundation input.
/// Captures land in config.capturesDir as <captureId>.wav (16 kHz mono
/// pcm_s16le — the same format ensureWav produces) plus a <captureId>.json
/// sidecar with the child PIDs so an orphaned capture can be killed and
/// removed on the next server start. On darwin, once a method is detected the
/// capability probe also runs a ~1 s self-test capture, validated with
/// ffprobe (duration) and ffmpeg volumedetect (level), so callers can tell a
/// present-but-silent setup from one that actually works (AUG-106).
/// On Windows (AUG-111) the loopback is a DirectShow capture device — the driver's
/// "Stereo Mix" or a virtual cable such as VB-Cable — read with ffmpeg -f dshow.
/// The preferred Windows method (AUG-112) is 'wasapi-loopback': a compiled C#
/// helper (see wasapiHelper.ts) taps the default output device with WASAPI
/// loopback and streams raw PCM into ffmpeg, so Bluetooth/USB headsets work
/// with no virtual device. dshow-loopback is the fallback.
/// AUG-113: a capture started with { live: true } additionally tees 16 kHz mono s16le PCM to ffmpeg's stdout so the live-transcription WebSocket can consume system audio server-side (see attachLiveSink); the WAV output is unchanged.

export class CaptureError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CaptureError';
  }
}

const CAPABILITY_TTL_MS = 30_000;
const START_GRACE_MS = 700;
const STOP_SOFT_TIMEOUT_MS = 1_500;
const STOP_HARD_TIMEOUT_MS = 5_000;
const STOPPED_CAPTURE_TTL_MS = 10 * 60_000;

// ~1 s self-test capture (AUG-106; macOS and Windows): confirms the detected method
// actually produces non-silent audio, not just that a binary/device exists.
const SELF_TEST_CAPTURE_MS = 1_000;
const SELF_TEST_STOP_SOFT_TIMEOUT_MS = 800;
const SELF_TEST_STOP_HARD_TIMEOUT_MS = 1_200;
const SELF_TEST_MIN_DURATION_SEC = 0.5;
// dshow devices deliver their first packet ~1.2 s after spawn (measured on
// Windows in AUG-111), so the self-test waits for the first byte before it
// starts counting its 1 s window; otherwise it would stop before any audio.
const SELF_TEST_FIRST_BYTE_TIMEOUT_MS = 3_000;
export const SELF_TEST_SILENCE_MEAN_DB = -60;
const STDERR_EXCERPT_CHARS = 400;

/// Hard budget for the one-time audiotee sample-format probe; it runs only on
/// an uncached capability probe, so cached probes pay nothing (AUG-107).
const SAMPLE_FORMAT_PROBE_TIMEOUT_MS = 450;

// First-written-byte detection (AUG-108). The capture's startedAt is the
// moment the first audio packet lands in the WAV file, not the spawn time,
// so device startup latency (100–300 ms, more for a cold audiotee tap) no
// longer skews systemOffsetMs. ffmpeg runs with `-flush_packets 1` so each
// packet reaches the file immediately instead of sitting in the ~32 KiB AVIO
// buffer (≈1 s of 16 kHz mono s16le), and `-fflags +bitexact` so the header
// is exactly the 44-byte RIFF/fmt/data preamble with no LIST/INFO chunk.
const FIRST_BYTE_POLL_MS = 25;
const FIRST_BYTE_TIMEOUT_MS = 2_000;
const WAV_HEADER_BYTES = 44;

export type StartedAtSource = 'first-byte' | 'spawn';

/// Live PCM tee (AUG-113): when a capture is started with { live: true }, ffmpeg
/// gets a second output — 16 kHz mono s16le on stdout — next to the unchanged WAV
/// file output, so the live-transcription WebSocket can consume system audio
/// without a browser MediaStream. stdout is drained from spawn onward (a full
/// pipe would stall ffmpeg and the WAV with it); bytes reach a sink only while
/// one is attached via attachLiveSink().
const LIVE_TEE_ARGS = ['-f', 's16le', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-flush_packets', '1', 'pipe:1'];

export interface CaptureLiveSink {
  /// Raw s16le mono 16 kHz bytes; chunk boundaries are arbitrary (may split a sample).
  onPcm(pcm: Buffer): void;
  /// Fired once when the tee stops for good: the capture was stopped ('stop') or
  /// ffmpeg's stdout ended on its own ('exit'). Not fired on an explicit detach().
  onEnd(reason: 'stop' | 'exit'): void;
}

export interface LiveSinkHandle {
  detach(): void;
}

interface LiveTee {
  sink: CaptureLiveSink | null;
  ended: boolean;
}

function endLiveTee(tee: LiveTee, reason: 'stop' | 'exit'): void {
  if (tee.ended) return;
  tee.ended = true;
  const sink = tee.sink;
  tee.sink = null;
  try { sink?.onEnd(reason); } catch { /* sink errors must not affect the capture */ }
}

export interface ResolvedCapabilities extends CaptureCapabilities {
  deviceIndex?: number;
  deviceName?: string;
  wasapi?: { exePath: string; probe: WasapiProbe };
}

/// Which device a method reads from: avfoundation uses a numeric index
/// (blackhole), dshow uses the exact friendly name (dshow-loopback).
/// wasapi-loopback carries the helper exe and its probed mix format.
export interface CaptureTarget {
  deviceIndex?: number;
  deviceName?: string;
  wasapi?: { exePath: string; probe: WasapiProbe };
}

interface ActiveCapture {
  captureId: string;
  method: CaptureMethod;
  spawnedAt: number;
  startedAt: number;
  startedAtSource: StartedAtSource;
  stoppedAt: number | null;
  filePath: string;
  sidecarPath: string;
  procs: ChildProcess[];
  stderr: string;
  exited: Promise<void>;
  live: LiveTee | null;
}

const captures = new Map<string, ActiveCapture>();
let cachedCapabilities: { value: ResolvedCapabilities; at: number } | null = null;

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/// Polls `filePath` until it holds more than the WAV header, i.e. the first
/// audio sample has been written, and returns that wall-clock time. Returns
/// null if `exited` settles or `timeoutMs` elapses first. Chained awaits
/// (not setInterval) guarantee nothing keeps running once the first byte is
/// seen (AUG-108).
export async function waitForFirstByte(
  filePath: string,
  exited: Promise<void>,
  opts: { timeoutMs?: number; pollMs?: number; headerBytes?: number } = {},
): Promise<number | null> {
  const timeoutMs = opts.timeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? FIRST_BYTE_POLL_MS;
  const headerBytes = opts.headerBytes ?? WAV_HEADER_BYTES;
  let processExited = false;
  void exited.then(() => { processExited = true; });
  const deadline = Date.now() + timeoutMs;
  while (!processExited) {
    try {
      const { size } = await fs.stat(filePath);
      if (size > headerBytes) return Date.now();
    } catch { /* file not created yet */ }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await delay(Math.min(pollMs, remaining), undefined);
  }
  return null;
}

/// Parses the stderr of `ffmpeg -f avfoundation -list_devices true -i ""`.
/// Lines look like `[AVFoundation indev @ 0x...] [2] BlackHole 2ch`, grouped
/// under "AVFoundation video devices:" / "AVFoundation audio devices:".
export function parseAvfoundationAudioDevices(stderr: string): Array<{ index: number; name: string }> {
  const devices: Array<{ index: number; name: string }> = [];
  let inAudioSection = false;
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[AVFoundation[^\]]*\]\s*/, '').trim();
    if (/^AVFoundation audio devices:/i.test(line)) { inAudioSection = true; continue; }
    if (/^AVFoundation video devices:/i.test(line)) { inAudioSection = false; continue; }
    if (!inAudioSection) continue;
    const match = line.match(/^\[(\d+)\]\s+(.+)$/);
    if (match) devices.push({ index: Number(match[1]), name: match[2].trim() });
  }
  return devices;
}

export function findLoopbackDevice(devices: Array<{ index: number; name: string }>): { index: number; name: string } | null {
  return devices.find((d) => /blackhole/i.test(d.name)) ?? null;
}

/// Parses the stderr of `ffmpeg -list_devices true -f dshow -i dummy` into
/// audio device friendly names. Handles both the ffmpeg ≥ 6 layout
/// (`[in#0 @ 0x...] "Name" (audio)`) and the older layout (a
/// `DirectShow audio devices` header followed by `[dshow @ 0x...]  "Name"`).
/// `Alternative name "..."` lines are skipped in both layouts.
export function parseDshowAudioDevices(stderr: string): string[] {
  const names: string[] = [];
  let inAudioSection = false;
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*/, '').trim();
    if (/^Alternative name/i.test(line)) continue;
    const tagged = line.match(/^"([^"]+)"\s*\((audio|video)\)$/i);
    if (tagged) {
      if (tagged[2].toLowerCase() === 'audio') names.push(tagged[1]);
      continue;
    }
    if (/^DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
    if (/^DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
    if (!inAudioSection) continue;
    const plain = line.match(/^"([^"]+)"$/);
    if (plain) names.push(plain[1]);
  }
  return names;
}

/// Loopback-style DirectShow inputs: the Realtek/onboard "Stereo Mix" (localised
/// e.g. "Стерео микшер"), Creative "What U Hear", and virtual cables such as
/// VB-Cable ("CABLE Output") or Voicemeeter.
const DSHOW_LOOPBACK_PATTERN = /stereo mix|стерео микшер|what u hear|wave out mix|cable output|voicemeeter out|virtual.*cable|loopback/i;

export function findDshowLoopbackDevice(names: string[]): string | null {
  return names.find((n) => DSHOW_LOOPBACK_PATTERN.test(n)) ?? null;
}

async function commandOnPath(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000 }, (error) => {
      // Any exit code other than "binary not found" means the command exists.
      resolve(!error || (error as NodeJS.ErrnoException).code !== 'ENOENT');
    });
  });
}

export async function listAvfoundationAudioDevices(): Promise<Array<{ index: number; name: string }>> {
  return new Promise((resolve) => {
    execFile(
      config.ffmpegPath,
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { timeout: 10_000 },
      (_error, _stdout, stderr) => {
        // ffmpeg exits non-zero after listing; the device table is on stderr regardless.
        resolve(parseAvfoundationAudioDevices(stderr ?? ''));
      },
    );
  });
}

export async function listDshowAudioDevices(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      config.ffmpegPath,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { timeout: 10_000 },
      (_error, _stdout, stderr) => {
        // ffmpeg exits non-zero ("Error opening input file dummy"); the list is on stderr.
        resolve(parseDshowAudioDevices(stderr ?? ''));
      },
    );
  });
}

/// Spawns audiotee exactly as startCapture() does, collects ~200 ms of its raw
/// stdout (or whatever arrived within the time budget), then ends it. The
/// bytes go to detectPcmSampleFormat; an empty/short result is handled there.
function readAudioteeSample(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const tap = spawn('audiotee', ['--sample-rate', '16000'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { tap.kill('SIGTERM'); } catch { /* already gone */ }
      const hardKill = setTimeout(() => { try { tap.kill('SIGKILL'); } catch { /* already gone */ } }, 500);
      hardKill.unref();
      tap.once('exit', () => clearTimeout(hardKill));
      if (err && total === 0) reject(err);
      else resolve(Buffer.concat(chunks, total));
    };
    const timer = setTimeout(() => finish(), SAMPLE_FORMAT_PROBE_TIMEOUT_MS);
    tap.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= SAMPLE_FORMAT_PROBE_BYTES) finish();
    });
    tap.on('error', (err) => finish(err));
    tap.on('exit', () => finish());
  });
}

interface CapturePipeline {
  procs: ChildProcess[];
  ffmpeg: ChildProcess;
  exited: Promise<void>;
  live: LiveTee | null;
  stderr(): string;
}

/// Spawns the capture processes for `method` writing 16 kHz mono pcm_s16le to
/// filePath. Shared by startCapture() and the self-test (AUG-106) so the
/// ffmpeg command line exists once.
///
/// stdin handling differs per method on purpose (AUG-110, AUG-111):
///  - coreaudio-tap: audiotee's stdout is piped INTO ffmpeg's stdin ('pipe').
///    Stopping the tap closes that pipe, ffmpeg sees EOF and finalizes the WAV
///    header — the correct stop for a piped input.
///  - blackhole: ffmpeg reads the device itself, so stdin is unused. It is
///    'ignore' + `-nostdin`, and the stop path relies on SIGINT (ffmpeg's
///    documented graceful shutdown) rather than writing 'q' to stdin.
///  - dshow-loopback (Windows): Node cannot deliver SIGINT on Windows — kill()
///    is TerminateProcess and leaves the RIFF size unfinalized. stdin is a
///    'pipe' WITHOUT -nostdin and the stop path writes 'q', ffmpeg's interactive
///    quit, which finalizes the header (verified: exit 0, correct RIFF size).
///  - wasapi-loopback (Windows): the helper's stdout is piped INTO ffmpeg's
///    stdin, exactly like coreaudio-tap. Terminating the helper closes the
///    pipe; ffmpeg finalizes the WAV on EOF (verified: exit 0, correct RIFF size).
///    ffmpeg is spawned before the helper so its startup does not queue helper frames.
/// With live=true (AUG-113) ffmpeg gets stdout as a pipe and LIVE_TEE_ARGS as a second output after the WAV path.
function spawnCapturePipeline(
  method: Exclude<CaptureMethod, 'none'>,
  target: CaptureTarget,
  filePath: string,
  sampleFormat?: string,
  live = false,
): CapturePipeline {
  const procs: ChildProcess[] = [];
  let stderr = '';
  const collect = (chunk: Buffer | string) => { stderr += chunk.toString(); };
  let ffmpeg: ChildProcess;
  if (method === 'coreaudio-tap') {
    const tap = spawn('audiotee', ['--sample-rate', '16000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpeg = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-f', sampleFormat ?? 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-fflags', '+bitexact', '-y', filePath, ...(live ? LIVE_TEE_ARGS : [])],
      { stdio: ['pipe', live ? 'pipe' : 'ignore', 'pipe'] },
    );
    tap.stdout?.pipe(ffmpeg.stdin!);
    tap.stderr?.on('data', collect);
    tap.on('error', (err) => collect(`audiotee: ${err.message}\n`));
    procs.push(tap, ffmpeg);
  } else if (method === 'wasapi-loopback') {
    const wasapi = target.wasapi;
    if (!wasapi) throw new CaptureError('wasapi-loopback capture requested without a probed helper');
    // ffmpeg first: the helper zero-fills from its own start, so if ffmpeg were still
    // booting (~100 ms on Windows) those frames would queue in the pipe and the WAV
    // would begin before the first-byte startedAt, skewing systemOffsetMs (AUG-112).
    ffmpeg = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-f', wasapi.probe.format, '-ar', String(wasapi.probe.sampleRate), '-ac', String(wasapi.probe.channels), '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-fflags', '+bitexact', '-y', filePath, ...(live ? LIVE_TEE_ARGS : [])],
      { stdio: ['pipe', live ? 'pipe' : 'ignore', 'pipe'] },
    );
    const helper = spawn(wasapi.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    helper.stdout?.pipe(ffmpeg.stdin!);
    helper.stderr?.on('data', collect);
    helper.on('error', (err) => collect(`wasapi-loopback: ${err.message}\n`));
    // Order matters for stopCaptureProcesses: helper first, ffmpeg last.
    procs.push(helper, ffmpeg);
  } else if (method === 'dshow-loopback') {
    ffmpeg = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${target.deviceName}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-fflags', '+bitexact', '-y', filePath, ...(live ? LIVE_TEE_ARGS : [])],
      { stdio: ['pipe', live ? 'pipe' : 'ignore', 'pipe'] },
    );
    procs.push(ffmpeg);
  } else {
    ffmpeg = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'avfoundation', '-i', `:${target.deviceIndex}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-fflags', '+bitexact', '-y', filePath, ...(live ? LIVE_TEE_ARGS : [])],
      { stdio: ['ignore', live ? 'pipe' : 'ignore', 'pipe'] },
    );
    procs.push(ffmpeg);
  }
  ffmpeg.stderr?.on('data', collect);
  ffmpeg.on('error', (err) => collect(`ffmpeg: ${err.message}\n`));
  const exited = new Promise<void>((resolve) => {
    ffmpeg.once('exit', () => resolve());
    ffmpeg.once('error', () => resolve());
  });
  let tee: LiveTee | null = null;
  if (live && ffmpeg.stdout) {
    const t: LiveTee = { sink: null, ended: false };
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      try { t.sink?.onPcm(chunk); } catch { /* sink errors must not stall the capture */ }
    });
    ffmpeg.stdout.once('end', () => endLiveTee(t, 'exit'));
    ffmpeg.stdout.once('close', () => endLiveTee(t, 'exit'));
    ffmpeg.stdout.on('error', () => endLiveTee(t, 'exit'));
    tee = t;
  }
  return { procs, ffmpeg, exited, live: tee, stderr: () => stderr };
}

function killAll(procs: ChildProcess[]): void {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
}

/// Detects the capture method and, for coreaudio-tap, its sample format —
/// but does not run the self-test. Split out of probeCapabilities() (AUG-106)
/// so startCapture() can resolve just the method without paying for (or
/// colliding with) the ~1 s self-test.
const WINDOWS_NO_LOOPBACK_HINT = 'No loopback capture device found. Enable "Stereo Mix" in Sound settings > Recording (right-click > Show Disabled Devices; it captures only the onboard Realtek output, not Bluetooth/USB headsets), or install VB-Cable and set "CABLE Input" as the default output device, then restart the server.';

export interface WindowsProbeInput {
  platform: string;
  ffmpeg: boolean;
  wasapi: WasapiHelperStatus;
  dshowDevices: string[];
}

/// Pure preference order for Windows (AUG-111, AUG-112): WASAPI helper first
/// (captures the default output, any device type), then a DirectShow loopback
/// device, then none. Exported so the order is unit-testable without spawning.
export function resolveWindowsMethod(input: WindowsProbeInput): ResolvedCapabilities {
  const { platform } = input;
  if (!input.ffmpeg) {
    return {
      systemCapture: false,
      method: 'none',
      platform,
      hint: 'ffmpeg is required for system capture: run `npm run setup` (bundled build) or winget install ffmpeg',
      selfTest: 'skipped',
      selfTestDetail: 'no capture method to test',
    };
  }
  if (input.wasapi.ok) {
    const { probe } = input.wasapi;
    return {
      systemCapture: true,
      method: 'wasapi-loopback',
      platform,
      hint: `WASAPI loopback of the default output "${probe.device}" (${probe.sampleRate} Hz, ${probe.channels} ch, ${probe.format}) — no virtual device needed.`,
      wasapi: { exePath: input.wasapi.exePath, probe },
      selfTest: 'skipped',
      selfTestDetail: '',
    };
  }
  const wasapiNote = `WASAPI helper unavailable: ${input.wasapi.reason}`;
  const loopback = findDshowLoopbackDevice(input.dshowDevices);
  if (loopback) {
    return {
      systemCapture: true,
      method: 'dshow-loopback',
      platform,
      hint: `DirectShow loopback device "${loopback}". Playback must be routed through it (Stereo Mix mirrors the Realtek output; VB-Cable needs "CABLE Input" as the default output). ${wasapiNote}.`,
      deviceName: loopback,
      selfTest: 'skipped',
      selfTestDetail: '',
    };
  }
  return {
    systemCapture: false,
    method: 'none',
    platform,
    hint: `${WINDOWS_NO_LOOPBACK_HINT} ${wasapiNote}.`,
    selfTest: 'skipped',
    selfTestDetail: 'no capture method to test',
  };
}

async function probeWindowsMethod(platform: string): Promise<ResolvedCapabilities> {
  if (!(await checkFfmpegAvailable())) {
    return resolveWindowsMethod({ platform, ffmpeg: false, wasapi: { ok: false, reason: 'not probed' }, dshowDevices: [] });
  }
  const [wasapi, dshowDevices] = await Promise.all([getWasapiHelperStatus(), listDshowAudioDevices()]);
  return resolveWindowsMethod({ platform, ffmpeg: true, wasapi, dshowDevices });
}

async function probeMethod(): Promise<ResolvedCapabilities> {
  const platform = process.platform;
  if (platform === 'win32') return probeWindowsMethod(platform);
  if (platform !== 'darwin') {
    return {
      systemCapture: false,
      method: 'none',
      platform,
      hint: 'Direct system capture is supported on macOS and Windows only — this platform uses the browser screen picker.',
      selfTest: 'skipped',
      selfTestDetail: 'unsupported platform',
    };
  }
  if (!(await checkFfmpegAvailable())) {
    return {
      systemCapture: false,
      method: 'none',
      platform,
      hint: 'ffmpeg is required for system capture: run `npm run setup` (bundled build) or brew install ffmpeg',
      selfTest: 'skipped',
      selfTestDetail: 'no capture method to test',
    };
  }
  if (await commandOnPath('audiotee', ['--help'])) {
    const pcm = await resolveAudioteeSampleFormat(config.audioteeSampleFormat, readAudioteeSample);
    if (pcm.sampleFormatSource === 'fallback') {
      console.warn(`audiotee sample-format probe inconclusive (${pcm.detail}); assuming s16le. Set AUDIOTEE_SAMPLE_FORMAT to override.`);
    }
    const origin = pcm.sampleFormatSource === 'override' ? 'from AUDIOTEE_SAMPLE_FORMAT' : pcm.sampleFormatSource;
    return {
      systemCapture: true,
      method: 'coreaudio-tap',
      platform,
      hint: `Core Audio tap via audiotee (macOS 14.2+), PCM ${pcm.sampleFormat} (${origin}). Grant "System Audio Recording" permission on first use.`,
      sampleFormat: pcm.sampleFormat,
      sampleFormatSource: pcm.sampleFormatSource,
      selfTest: 'skipped',
      selfTestDetail: '',
    };
  }
  const loopback = findLoopbackDevice(await listAvfoundationAudioDevices());
  if (loopback) {
    return {
      systemCapture: true,
      method: 'blackhole',
      platform,
      hint: `BlackHole loopback device "${loopback.name}" (avfoundation index ${loopback.index}). Route output through it via a Multi-Output Device.`,
      deviceIndex: loopback.index,
      selfTest: 'skipped',
      selfTestDetail: '',
    };
  }
  return {
    systemCapture: false,
    method: 'none',
    platform,
    hint: 'No capture helper found. Install BlackHole (brew install blackhole-2ch) and route output through it, or build audiotee (Core Audio tap, macOS 14.2+) onto PATH, then restart the server.',
    selfTest: 'skipped',
    selfTestDetail: 'no capture method to test',
  };
}

/// Full probe: detects the method, then (when one was found) runs the ~1 s
/// self-test capture (AUG-106).
async function probeCapabilities(): Promise<ResolvedCapabilities> {
  const caps = await probeMethod();
  if (!caps.systemCapture || caps.method === 'none') return caps;
  const result = await runSelfTest(caps.method, { deviceIndex: caps.deviceIndex, deviceName: caps.deviceName, wasapi: caps.wasapi }, caps.sampleFormat);
  return { ...caps, ...result };
}

let inflightProbe: Promise<ResolvedCapabilities> | null = null;

export async function detectCapabilities(force = false): Promise<CaptureCapabilities> {
  const now = Date.now();
  if (!force && cachedCapabilities && now - cachedCapabilities.at < CAPABILITY_TTL_MS) {
    return stripInternal(cachedCapabilities.value);
  }
  if (!inflightProbe) {
    inflightProbe = probeCapabilities()
      .then((value) => { cachedCapabilities = { value, at: Date.now() }; return value; })
      .finally(() => { inflightProbe = null; });
  }
  return stripInternal(await inflightProbe);
}

/// startCapture() must not pay for (or collide with) the 1 s self-test, so it
/// takes a fresh cached result when available and otherwise detects only the
/// method (AUG-106).
async function resolveCaptureMethod(): Promise<ResolvedCapabilities> {
  if (cachedCapabilities && Date.now() - cachedCapabilities.at < CAPABILITY_TTL_MS) return cachedCapabilities.value;
  return probeMethod();
}

function stripInternal(caps: ResolvedCapabilities): CaptureCapabilities {
  const { deviceIndex: _deviceIndex, deviceName: _deviceName, wasapi: _wasapi, ...pub } = caps;
  return pub;
}

async function sweepExpiredCaptures(): Promise<void> {
  const now = Date.now();
  for (const capture of captures.values()) {
    if (capture.stoppedAt !== null && now - capture.stoppedAt > STOPPED_CAPTURE_TTL_MS) {
      captures.delete(capture.captureId);
      await fs.rm(capture.filePath, { force: true }).catch(() => {});
      await fs.rm(capture.sidecarPath, { force: true }).catch(() => {});
    }
  }
}

export async function startCapture(opts: { live?: boolean } = {}): Promise<StartedCapture> {
  await sweepExpiredCaptures();
  const caps = await resolveCaptureMethod();
  if (!caps.systemCapture || caps.method === 'none') {
    throw new CaptureError(`System capture unavailable: ${caps.hint}`);
  }

  await fs.mkdir(config.capturesDir, { recursive: true });
  const captureId = randomUUID();
  const filePath = path.join(config.capturesDir, `${captureId}.wav`);
  const sidecarPath = path.join(config.capturesDir, `${captureId}.json`);

  const live = opts.live === true;
  const pipeline = spawnCapturePipeline(caps.method, { deviceIndex: caps.deviceIndex, deviceName: caps.deviceName, wasapi: caps.wasapi }, filePath, caps.sampleFormat, live);
  const spawnedAt = Date.now();

  // Wait for the first audio byte (or 2 s / process exit), then keep the
  // original start-grace window so an immediate crash is still reported.
  const firstByteAt = await waitForFirstByte(filePath, pipeline.exited);
  const graceLeft = Math.max(0, START_GRACE_MS - (Date.now() - spawnedAt));
  const exitedEarly = await Promise.race([pipeline.exited.then(() => true), delay(graceLeft, false)]);
  if (exitedEarly) {
    killAll(pipeline.procs);
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw new CaptureError(`System capture failed to start: ${pipeline.stderr().trim() || 'capture process exited immediately'}`);
  }

  const startedAt = firstByteAt ?? spawnedAt;
  const startedAtSource: StartedAtSource = firstByteAt === null ? 'spawn' : 'first-byte';
  console.debug(`[capture ${captureId}] startedAt source=${startedAtSource}, first byte ${startedAt - spawnedAt} ms after spawn`);

  const capture: ActiveCapture = { captureId, method: caps.method, spawnedAt, startedAt, startedAtSource, stoppedAt: null, filePath, sidecarPath, procs: pipeline.procs, stderr: '', exited: pipeline.exited, live: pipeline.live };
  pipeline.ffmpeg.stderr?.on('data', (chunk) => { capture.stderr += chunk.toString(); });
  captures.set(captureId, capture);
  await fs.writeFile(
    sidecarPath,
    JSON.stringify({ captureId, spawnedAt, startedAt, startedAtSource, method: caps.method, live, pids: pipeline.procs.map((p) => p.pid).filter((pid): pid is number => typeof pid === 'number') }),
    'utf-8',
  ).catch(() => {});
  return { captureId, startedAt, spawnedAt, startedAtSource, live };
}

/// Minimal process surface needed to stop a capture. ChildProcess satisfies it;
/// tests substitute a fake so the signal sequence can be asserted without ffmpeg.
export interface StoppableProcess {
  kill(signal?: NodeJS.Signals): boolean;
  /// Present for dshow-loopback captures: ffmpeg's interactive stdin (write 'q' to quit).
  stdin?: { write(chunk: string): unknown; end(): unknown } | null;
}

export interface StopTimeouts {
  /// coreaudio-tap only: how long to wait for ffmpeg to exit on EOF before SIGINT.
  softTimeoutMs: number;
  /// How long to wait after the graceful signal before SIGKILL-ing everything.
  hardTimeoutMs: number;
}

const DEFAULT_STOP_TIMEOUTS: StopTimeouts = { softTimeoutMs: STOP_SOFT_TIMEOUT_MS, hardTimeoutMs: STOP_HARD_TIMEOUT_MS };

/// Signal sequence that ends a capture. `procs` is ordered as spawned: the
/// ffmpeg encoder is always last; for 'coreaudio-tap' the audiotee tap is first.
///  - coreaudio-tap: SIGTERM tap → (soft timeout) → SIGINT ffmpeg → (hard timeout) → SIGKILL all.
///    Ending the tap closes ffmpeg's stdin pipe; ffmpeg finalizes the WAV header on EOF.
///  - blackhole: SIGINT ffmpeg → (hard timeout) → SIGKILL all.
///    SIGINT is ffmpeg's documented graceful shutdown and finalizes the container
///    header. It does not depend on stdin, so `-nostdin` in the spawn args is safe.
///  - dshow-loopback (Windows): write 'q' + end stdin → (hard timeout) → SIGKILL all.
///    Windows has no deliverable SIGINT; ffmpeg's interactive 'q' is the only
///    graceful stop and it finalizes the WAV header (AUG-111).
///  - wasapi-loopback: same as coreaudio-tap — SIGTERM helper (TerminateProcess on
///    Windows) closes ffmpeg's stdin pipe → EOF finalizes the WAV → SIGKILL after timeouts.
export async function stopCaptureProcesses(
  method: CaptureMethod,
  procs: StoppableProcess[],
  exited: Promise<void>,
  timeouts: StopTimeouts = DEFAULT_STOP_TIMEOUTS,
): Promise<void> {
  const ffmpeg = procs[procs.length - 1];
  const waitFor = (ms: number) => Promise.race([exited.then(() => true), delay(ms, false)]);
  let done: boolean;
  if (method === 'coreaudio-tap' || method === 'wasapi-loopback') {
    try { procs[0].kill('SIGTERM'); } catch { /* already gone */ }
    done = await waitFor(timeouts.softTimeoutMs);
    if (!done) {
      try { ffmpeg.kill('SIGINT'); } catch { /* already gone */ }
      done = await waitFor(timeouts.hardTimeoutMs);
    }
  } else if (method === 'dshow-loopback') {
    try { ffmpeg.stdin?.write('q'); ffmpeg.stdin?.end(); } catch { /* stdin already closed */ }
    done = await waitFor(timeouts.hardTimeoutMs);
  } else {
    try { ffmpeg.kill('SIGINT'); } catch { /* already gone */ }
    done = await waitFor(timeouts.hardTimeoutMs);
  }
  if (!done) {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
    await exited;
  }
}

async function gracefulStop(capture: ActiveCapture): Promise<void> {
  await stopCaptureProcesses(capture.method, capture.procs, capture.exited);
}

export interface VolumeDetectResult {
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}

/// Parses `ffmpeg -af volumedetect -f null -` stderr. Lines look like
/// `[Parsed_volumedetect_0 @ 0x...] mean_volume: -91.0 dB`. ffmpeg prints `-inf dB`
/// for all-zero input; that maps to -Infinity.
export function parseVolumeDetect(stderr: string): VolumeDetectResult {
  const read = (key: 'mean_volume' | 'max_volume'): number | null => {
    const match = stderr.match(new RegExp(`${key}:\\s*(-?inf|-?\\d+(?:\\.\\d+)?)\\s*dB`, 'i'));
    if (!match) return null;
    if (/inf/i.test(match[1])) return match[1].startsWith('-') ? -Infinity : Infinity;
    return Number(match[1]);
  };
  return { meanVolumeDb: read('mean_volume'), maxVolumeDb: read('max_volume') };
}

/// A capture counts as silent when its mean level is at or below SELF_TEST_SILENCE_MEAN_DB
/// (-60 dB) or volumedetect reported no level at all.
export function isSilentLevel(volume: VolumeDetectResult): boolean {
  return volume.meanVolumeDb === null || volume.meanVolumeDb <= SELF_TEST_SILENCE_MEAN_DB;
}

async function measureVolume(filePath: string): Promise<VolumeDetectResult> {
  return new Promise((resolve) => {
    execFile(
      config.ffmpegPath,
      ['-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'],
      { timeout: 10_000 },
      (_error, _stdout, stderr) => resolve(parseVolumeDetect(stderr ?? '')),
    );
  });
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_EXCERPT_CHARS ? `…${trimmed.slice(-STDERR_EXCERPT_CHARS)}` : trimmed;
}

function silentHint(method: CaptureMethod): string {
  if (method === 'blackhole') {
    return 'capture was silent — in Audio MIDI Setup create a Multi-Output Device that includes BlackHole, select it as the system output, and make sure something is playing';
  }
  if (method === 'dshow-loopback') {
    return 'capture was silent — make sure the loopback device is enabled in Sound settings > Recording, that playback goes through the matching output (Stereo Mix mirrors only the Realtek output; VB-Cable needs "CABLE Input" as the default output), and that something is playing';
  }
  if (method === 'wasapi-loopback') {
    return 'capture was silent — the WASAPI loopback of the default output heard nothing; make sure audio is actually playing through that device (the helper follows the device that was default when the capture started)';
  }
  return 'capture was silent — make sure audio is playing and that "System Audio Recording" permission is granted to the process running the server';
}

function hasRunningCapture(): boolean {
  for (const capture of captures.values()) if (capture.stoppedAt === null) return true;
  return false;
}

function formatDb(db: number | null): string {
  if (db === null) return 'n/a';
  if (!Number.isFinite(db)) return `${db < 0 ? '-' : ''}inf dB`;
  return `${db.toFixed(1)} dB`;
}

/// Records ~1 s with the same pipeline startCapture() uses, then checks
/// duration (ffprobe) and level (ffmpeg volumedetect). The temp file is
/// always removed (AUG-106).
async function runSelfTest(
  method: Exclude<CaptureMethod, 'none'>,
  target: CaptureTarget,
  sampleFormat: string | undefined,
): Promise<Pick<CaptureCapabilities, 'selfTest' | 'selfTestDetail'>> {
  if (hasRunningCapture()) {
    return { selfTest: 'skipped', selfTestDetail: 'a system capture is already running' };
  }
  await fs.mkdir(config.capturesDir, { recursive: true });
  const tempPath = path.join(config.capturesDir, `selftest-${randomUUID()}.wav`);
  let pipeline: CapturePipeline | null = null;
  try {
    pipeline = spawnCapturePipeline(method, target, tempPath, sampleFormat);
    // Count the 1 s window from the first audio byte, not from spawn (dshow
    // needs ~1.2 s to start delivering; see SELF_TEST_FIRST_BYTE_TIMEOUT_MS).
    const firstByteAt = await waitForFirstByte(tempPath, pipeline.exited, { timeoutMs: SELF_TEST_FIRST_BYTE_TIMEOUT_MS });
    const exitedEarly = firstByteAt === null
      ? true
      : await Promise.race([pipeline.exited.then(() => true), delay(SELF_TEST_CAPTURE_MS, false)]);
    if (exitedEarly) {
      return { selfTest: 'failed', selfTestDetail: excerpt(pipeline.stderr()) || 'capture process exited or produced no audio within the start window' };
    }
    await stopCaptureProcesses(method, pipeline.procs, pipeline.exited, {
      softTimeoutMs: SELF_TEST_STOP_SOFT_TIMEOUT_MS,
      hardTimeoutMs: SELF_TEST_STOP_HARD_TIMEOUT_MS,
    });
    if (!(await fileExists(tempPath))) {
      return { selfTest: 'failed', selfTestDetail: excerpt(pipeline.stderr()) || 'capture produced no audio file' };
    }
    const durationSec = await getAudioDuration(tempPath);
    if (durationSec < SELF_TEST_MIN_DURATION_SEC) {
      const stderrExcerpt = excerpt(pipeline.stderr());
      return {
        selfTest: 'failed',
        selfTestDetail: `capture produced ${durationSec.toFixed(2)} s of audio (expected ≥ ${SELF_TEST_MIN_DURATION_SEC} s)${stderrExcerpt ? `: ${stderrExcerpt}` : ''}`,
      };
    }
    const volume = await measureVolume(tempPath);
    const level = `mean ${formatDb(volume.meanVolumeDb)}, max ${formatDb(volume.maxVolumeDb)} over ${durationSec.toFixed(1)} s`;
    if (isSilentLevel(volume)) {
      return { selfTest: 'silent', selfTestDetail: `${silentHint(method)} (${level})` };
    }
    return { selfTest: 'ok', selfTestDetail: level };
  } catch (err) {
    return { selfTest: 'failed', selfTestDetail: excerpt((err as Error)?.message ?? String(err)) || 'self-test crashed' };
  } finally {
    if (pipeline) killAll(pipeline.procs);
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export interface StartedCapture {
  captureId: string;
  /// Wall-clock ms of the first audio byte written (or spawn time when startedAtSource is 'spawn').
  startedAt: number;
  /// Wall-clock ms when ffmpeg was spawned; startedAt − spawnedAt is the device startup latency.
  spawnedAt: number;
  startedAtSource: StartedAtSource;
  /// True when the capture tees live PCM for the live-transcription WebSocket (AUG-113).
  live: boolean;
}

export interface StoppedCapture extends StartedCapture {
  path: string;
  durationMs: number;
}

export async function stopCapture(captureId: string): Promise<StoppedCapture> {
  const capture = captures.get(captureId);
  if (!capture) throw new CaptureError('Unknown or expired captureId');
  if (capture.stoppedAt === null) {
    capture.stoppedAt = Date.now();
    // AUG-113: detach the live sink first (its onEnd flushes the last partial
    // window into the live transcription queue), then finalize the WAV.
    if (capture.live) endLiveTee(capture.live, 'stop');
    await gracefulStop(capture);
  }
  if (!(await fileExists(capture.filePath))) {
    captures.delete(captureId);
    await fs.rm(capture.sidecarPath, { force: true }).catch(() => {});
    throw new CaptureError(`System capture produced no audio file: ${capture.stderr.trim() || 'unknown error'}`);
  }
  return { captureId, path: capture.filePath, startedAt: capture.startedAt, spawnedAt: capture.spawnedAt, startedAtSource: capture.startedAtSource, live: capture.live !== null, durationMs: capture.stoppedAt - capture.startedAt };
}

/// Stops (if still running) and hands the capture file over to the caller,
/// removing it from the registry. The caller owns the file afterwards.
export async function consumeCapture(captureId: string): Promise<StoppedCapture> {
  const stopped = await stopCapture(captureId);
  const capture = captures.get(captureId);
  captures.delete(captureId);
  if (capture) await fs.rm(capture.sidecarPath, { force: true }).catch(() => {});
  return stopped;
}

export function hasCapture(captureId: string): boolean {
  return captures.has(captureId);
}

/// Binds a live-transcription consumer to a running capture's PCM tee (AUG-113).
/// Exactly one sink per capture; the handle's detach() unbinds without stopping
/// the capture (the WAV keeps recording until stopCapture).
export function attachLiveSink(captureId: string, sink: CaptureLiveSink): LiveSinkHandle {
  const capture = captures.get(captureId);
  if (!capture) throw new CaptureError('Unknown or expired captureId');
  if (capture.stoppedAt !== null) throw new CaptureError('Capture has already been stopped');
  const tee = capture.live;
  if (!tee || tee.ended) throw new CaptureError('Capture was not started with live: true');
  if (tee.sink) throw new CaptureError('Capture is already attached to another live session');
  tee.sink = sink;
  return { detach: () => { if (tee.sink === sink) tee.sink = null; } };
}

/// Server start: the in-memory registry is empty, so every file left in
/// capturesDir belongs to a capture whose client or server died. Kill any
/// PIDs recorded in sidecars and delete everything.
export async function cleanupOrphanedCaptures(): Promise<number> {
  let removed = 0;
  try {
    await fs.mkdir(config.capturesDir, { recursive: true });
    const entries = await fs.readdir(config.capturesDir);
    for (const entry of entries.filter((e) => e.endsWith('.json'))) {
      try {
        const sidecar = JSON.parse(await fs.readFile(path.join(config.capturesDir, entry), 'utf-8')) as { pids?: number[] };
        for (const pid of sidecar.pids ?? []) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* not running */ }
        }
      } catch { /* unreadable sidecar — still deleted below */ }
    }
    for (const entry of entries) {
      await fs.rm(path.join(config.capturesDir, entry), { force: true });
      removed++;
    }
    if (removed > 0) console.log(`Cleaned up ${removed} orphaned system capture file(s)`);
  } catch (err) {
    console.error('Failed to clean up orphaned system captures:', err);
  }
  return removed;
}
