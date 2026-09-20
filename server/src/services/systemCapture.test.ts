import { describe, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseAvfoundationAudioDevices,
  findLoopbackDevice,
  parseDshowAudioDevices,
  findDshowLoopbackDevice,
  resolveWindowsMethod,
  stopCaptureProcesses,
  waitForFirstByte,
  parseVolumeDetect,
  isSilentLevel,
  SELF_TEST_SILENCE_MEAN_DB,
  type StoppableProcess,
} from './systemCapture.js';

const FIXTURE = [
  '[AVFoundation indev @ 0x7f8a1c004a80] AVFoundation video devices:',
  '[AVFoundation indev @ 0x7f8a1c004a80] [0] FaceTime HD Camera',
  '[AVFoundation indev @ 0x7f8a1c004a80] [1] Capture screen 0',
  '[AVFoundation indev @ 0x7f8a1c004a80] AVFoundation audio devices:',
  '[AVFoundation indev @ 0x7f8a1c004a80] [0] MacBook Pro Microphone',
  '[AVFoundation indev @ 0x7f8a1c004a80] [1] BlackHole 2ch',
  '[AVFoundation indev @ 0x7f8a1c004a80] [2] External Headphones',
  ': Input/output error',
].join('\n');

describe('parseAvfoundationAudioDevices', () => {
  test('returns only the audio section with numeric indices', () => {
    expect(parseAvfoundationAudioDevices(FIXTURE)).toEqual([
      { index: 0, name: 'MacBook Pro Microphone' },
      { index: 1, name: 'BlackHole 2ch' },
      { index: 2, name: 'External Headphones' },
    ]);
  });

  test('empty stderr → no devices', () => {
    expect(parseAvfoundationAudioDevices('')).toEqual([]);
  });
});

describe('findLoopbackDevice', () => {
  test('finds BlackHole case-insensitively', () => {
    expect(findLoopbackDevice(parseAvfoundationAudioDevices(FIXTURE))).toEqual({ index: 1, name: 'BlackHole 2ch' });
  });

  test('null when absent', () => {
    expect(findLoopbackDevice([{ index: 0, name: 'Built-in Mic' }])).toBeNull();
  });
});

/// Fake ChildProcess: records every signal and resolves `exited` when it
/// receives `exitOn`. No real ffmpeg is involved, so this runs on Windows too.
class FakeProcess implements StoppableProcess {
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<void>;
  private resolveExit!: () => void;

  constructor(private readonly exitOn: NodeJS.Signals | 'q' | null) {
    this.exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
  }

  readonly stdinWrites: string[] = [];
  readonly stdin = {
    write: (chunk: string) => { this.stdinWrites.push(chunk); if (this.exitOn === 'q') this.resolveExit(); return true; },
    end: () => undefined,
  };

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    if (signal === this.exitOn) this.resolveExit();
    return true;
  }
}

const FAST = { softTimeoutMs: 20, hardTimeoutMs: 20 };

describe('stopCaptureProcesses', () => {
  test('blackhole: SIGINT is the first and only signal when ffmpeg exits on it', async () => {
    const ffmpeg = new FakeProcess('SIGINT');
    const started = Date.now();
    await stopCaptureProcesses('blackhole', [ffmpeg], ffmpeg.exited, FAST);
    expect(ffmpeg.signals).toEqual(['SIGINT']);
    expect(Date.now() - started).toBeLessThan(FAST.hardTimeoutMs);
  });

  test('blackhole: SIGKILL after the hard timeout when ffmpeg ignores SIGINT', async () => {
    const ffmpeg = new FakeProcess('SIGKILL');
    await stopCaptureProcesses('blackhole', [ffmpeg], ffmpeg.exited, FAST);
    expect(ffmpeg.signals).toEqual(['SIGINT', 'SIGKILL']);
  });

  test('coreaudio-tap: SIGTERM to the tap only; ffmpeg untouched when it exits on EOF', async () => {
    const tap = new FakeProcess(null);
    // ffmpeg "exits on EOF" — modelled as exiting as soon as the tap is terminated.
    let resolveFfmpegExit!: () => void;
    const ffmpegExited = new Promise<void>((resolve) => { resolveFfmpegExit = resolve; });
    const ffmpeg = new FakeProcess(null);
    const tapKill = tap.kill.bind(tap);
    tap.kill = (signal?: NodeJS.Signals) => { const r = tapKill(signal); if (signal === 'SIGTERM') resolveFfmpegExit(); return r; };

    await stopCaptureProcesses('coreaudio-tap', [tap, ffmpeg], ffmpegExited, FAST);
    expect(tap.signals).toEqual(['SIGTERM']);
    expect(ffmpeg.signals).toEqual([]);
  });

  test('coreaudio-tap: SIGTERM tap → SIGINT ffmpeg → SIGKILL both when nothing exits', async () => {
    const tap = new FakeProcess(null);
    const ffmpeg = new FakeProcess('SIGKILL');
    await stopCaptureProcesses('coreaudio-tap', [tap, ffmpeg], ffmpeg.exited, FAST);
    expect(tap.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(ffmpeg.signals).toEqual(['SIGINT', 'SIGKILL']);
  });

  test('coreaudio-tap: SIGINT to ffmpeg after soft timeout when EOF does not end it', async () => {
    const tap = new FakeProcess(null);
    const ffmpeg = new FakeProcess('SIGINT');
    await stopCaptureProcesses('coreaudio-tap', [tap, ffmpeg], ffmpeg.exited, FAST);
    expect(tap.signals).toEqual(['SIGTERM']);
    expect(ffmpeg.signals).toEqual(['SIGINT']);
  });
});

describe('waitForFirstByte', () => {
  const never = new Promise<void>(() => {});
  let dir: string;

  async function tmpWav(name: string, bytes: number): Promise<string> {
    dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'aug108-'));
    const file = path.join(dir, name);
    await fs.writeFile(file, Buffer.alloc(bytes));
    return file;
  }

  test('resolves once the file grows past the 44-byte header', async () => {
    const file = await tmpWav('grow.wav', 44);
    const before = Date.now();
    const pending = waitForFirstByte(file, never, { timeoutMs: 1_000, pollMs: 10 });
    setTimeout(() => { void fs.appendFile(file, Buffer.alloc(2048)); }, 60);
    const at = await pending;
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(before + 50);
  });

  test('header-only file within the timeout → null', async () => {
    const file = await tmpWav('header.wav', 44);
    expect(await waitForFirstByte(file, never, { timeoutMs: 80, pollMs: 10 })).toBeNull();
  });

  test('missing file within the timeout → null', async () => {
    expect(await waitForFirstByte(path.join(os.tmpdir(), 'aug108-missing', 'none.wav'), never, { timeoutMs: 80, pollMs: 10 })).toBeNull();
  });

  test('process exit before any byte → null well before the timeout', async () => {
    const file = await tmpWav('exit.wav', 0);
    const start = Date.now();
    expect(await waitForFirstByte(file, Promise.resolve(), { timeoutMs: 5_000, pollMs: 10 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

const SILENT_VOLUMEDETECT = [
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] n_samples: 16000',
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] mean_volume: -91.0 dB',
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] max_volume: -91.0 dB',
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] histogram_91db: 16000',
].join('\n');

const AUDIBLE_VOLUMEDETECT = [
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] n_samples: 16384',
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] mean_volume: -23.4 dB',
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] max_volume: -3.2 dB',
  '[Parsed_volumedetect_0 @ 0x600001d0c0a0] histogram_3db: 12',
].join('\n');

describe('parseVolumeDetect', () => {
  test('silent fixture → -91 dB mean and max', () => {
    expect(parseVolumeDetect(SILENT_VOLUMEDETECT)).toEqual({ meanVolumeDb: -91, maxVolumeDb: -91 });
  });
  test('audible fixture → measured levels', () => {
    expect(parseVolumeDetect(AUDIBLE_VOLUMEDETECT)).toEqual({ meanVolumeDb: -23.4, maxVolumeDb: -3.2 });
  });
  test('-inf dB parses to -Infinity', () => {
    expect(parseVolumeDetect('mean_volume: -inf dB\nmax_volume: -inf dB').meanVolumeDb).toBe(-Infinity);
  });
  test('missing lines → null', () => {
    expect(parseVolumeDetect('')).toEqual({ meanVolumeDb: null, maxVolumeDb: null });
  });
});

describe('isSilentLevel', () => {
  test('silent fixture is silent', () => {
    expect(isSilentLevel(parseVolumeDetect(SILENT_VOLUMEDETECT))).toBe(true);
  });
  test('audible fixture is not silent', () => {
    expect(isSilentLevel(parseVolumeDetect(AUDIBLE_VOLUMEDETECT))).toBe(false);
  });
  test('threshold is inclusive at the boundary', () => {
    expect(isSilentLevel({ meanVolumeDb: SELF_TEST_SILENCE_MEAN_DB, maxVolumeDb: -10 })).toBe(true);
    expect(isSilentLevel({ meanVolumeDb: SELF_TEST_SILENCE_MEAN_DB + 0.1, maxVolumeDb: -10 })).toBe(false);
  });
  test('no level reported counts as silent', () => {
    expect(isSilentLevel({ meanVolumeDb: null, maxVolumeDb: null })).toBe(true);
  });
});

const DSHOW_FIXTURE_NEW = [
  '[in#0 @ 0000021b7e05e940] "Microsoft® LifeCam HD-3000" (video)',
  '[in#0 @ 0000021b7e05e940]   Alternative name "@device_pnp_\\\\?\\usb#vid_045e&pid_0779&mi_00#6&2eaf4765&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
  '[in#0 @ 0000021b7e05e940] "Настольный микрофон (6- Microsoft® LifeCam HD-3000)" (audio)',
  '[in#0 @ 0000021b7e05e940]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{DCDE37B9-AFA9-4996-A2A0-5C8838AEF0A8}"',
  '[in#0 @ 0000021b7e05e940] "Stereo Mix (Realtek(R) Audio)" (audio)',
  '[in#0 @ 0000021b7e05e940]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{1111}"',
  '[in#0 @ 0000021b7e05e940] "CABLE Output (VB-Audio Virtual Cable)" (audio)',
  'Error opening input file dummy.',
].join('\n');

const DSHOW_FIXTURE_OLD = [
  '[dshow @ 000001f0] DirectShow video devices (some may be both video and audio devices)',
  '[dshow @ 000001f0]  "Integrated Camera"',
  '[dshow @ 000001f0]     Alternative name "@device_pnp_..."',
  '[dshow @ 000001f0] DirectShow audio devices',
  '[dshow @ 000001f0]  "Microphone (Realtek(R) Audio)"',
  '[dshow @ 000001f0]     Alternative name "@device_cm_..."',
  '[dshow @ 000001f0]  "Стерео микшер (Realtek(R) Audio)"',
  'dummy: Immediate exit requested',
].join('\n');

describe('parseDshowAudioDevices', () => {
  test('new layout: audio devices only, alternative names skipped', () => {
    expect(parseDshowAudioDevices(DSHOW_FIXTURE_NEW)).toEqual([
      'Настольный микрофон (6- Microsoft® LifeCam HD-3000)',
      'Stereo Mix (Realtek(R) Audio)',
      'CABLE Output (VB-Audio Virtual Cable)',
    ]);
  });

  test('old layout: audio section only', () => {
    expect(parseDshowAudioDevices(DSHOW_FIXTURE_OLD)).toEqual([
      'Microphone (Realtek(R) Audio)',
      'Стерео микшер (Realtek(R) Audio)',
    ]);
  });

  test('empty stderr → no devices', () => {
    expect(parseDshowAudioDevices('')).toEqual([]);
  });
});

describe('findDshowLoopbackDevice', () => {
  test('prefers the first loopback-like device in list order', () => {
    expect(findDshowLoopbackDevice(parseDshowAudioDevices(DSHOW_FIXTURE_NEW))).toBe('Stereo Mix (Realtek(R) Audio)');
  });

  test('matches localised Stereo Mix', () => {
    expect(findDshowLoopbackDevice(parseDshowAudioDevices(DSHOW_FIXTURE_OLD))).toBe('Стерео микшер (Realtek(R) Audio)');
  });

  test('matches VB-Cable when it is the only loopback', () => {
    expect(findDshowLoopbackDevice(['Microphone (USB Audio Device)', 'CABLE Output (VB-Audio Virtual Cable)'])).toBe('CABLE Output (VB-Audio Virtual Cable)');
  });

  test('null when only microphones are present', () => {
    expect(findDshowLoopbackDevice(['Microphone (USB Audio Device)', 'Headset (Jabra Evolve 75)'])).toBeNull();
  });
});

describe('stopCaptureProcesses: dshow-loopback', () => {
  test("writes 'q' to stdin and sends no signal when ffmpeg quits on it", async () => {
    const ffmpeg = new FakeProcess('q');
    await stopCaptureProcesses('dshow-loopback', [ffmpeg], ffmpeg.exited, FAST);
    expect(ffmpeg.stdinWrites).toEqual(['q']);
    expect(ffmpeg.signals).toEqual([]);
  });

  test("SIGKILL after the hard timeout when ffmpeg ignores 'q'", async () => {
    const ffmpeg = new FakeProcess('SIGKILL');
    await stopCaptureProcesses('dshow-loopback', [ffmpeg], ffmpeg.exited, FAST);
    expect(ffmpeg.stdinWrites).toEqual(['q']);
    expect(ffmpeg.signals).toEqual(['SIGKILL']);
  });
});

describe('resolveWindowsMethod preference order', () => {
  const probe = { sampleRate: 44100, channels: 2, format: 'f32le', bitsPerSample: 32, device: 'Headphones' };
  const wasapiOk = { ok: true as const, exePath: 'C:\\x\\wasapi-loopback.exe', probe };
  const wasapiFail = { ok: false as const, reason: 'csc failed: boom' };
  const dshow = ['Microphone (USB)', 'Stereo Mix (Realtek(R) Audio)'];

  test('WASAPI wins over a present dshow loopback', () => {
    const caps = resolveWindowsMethod({ platform: 'win32', ffmpeg: true, wasapi: wasapiOk, dshowDevices: dshow });
    expect(caps.method).toBe('wasapi-loopback');
    expect(caps.systemCapture).toBe(true);
    expect(caps.wasapi?.exePath).toBe(wasapiOk.exePath);
    expect(caps.hint).toContain('Headphones');
  });

  test('falls back to dshow and explains why WASAPI is unavailable', () => {
    const caps = resolveWindowsMethod({ platform: 'win32', ffmpeg: true, wasapi: wasapiFail, dshowDevices: dshow });
    expect(caps.method).toBe('dshow-loopback');
    expect(caps.deviceName).toBe('Stereo Mix (Realtek(R) Audio)');
    expect(caps.hint).toContain('csc failed: boom');
  });

  test('none when neither is available, hint carries the WASAPI reason', () => {
    const caps = resolveWindowsMethod({ platform: 'win32', ffmpeg: true, wasapi: wasapiFail, dshowDevices: ['Microphone (USB)'] });
    expect(caps.method).toBe('none');
    expect(caps.systemCapture).toBe(false);
    expect(caps.hint).toContain('Stereo Mix');
    expect(caps.hint).toContain('csc failed: boom');
  });

  test('missing ffmpeg short-circuits everything', () => {
    const caps = resolveWindowsMethod({ platform: 'win32', ffmpeg: false, wasapi: wasapiOk, dshowDevices: dshow });
    expect(caps.method).toBe('none');
    expect(caps.hint).toContain('ffmpeg');
  });
});

describe('stopCaptureProcesses: wasapi-loopback', () => {
  test('SIGTERM to the helper only when ffmpeg exits on the resulting EOF', async () => {
    const helper = new FakeProcess('SIGTERM');
    const ffmpeg = new FakeProcess(null);
    await stopCaptureProcesses('wasapi-loopback', [helper, ffmpeg], helper.exited, FAST);
    expect(helper.signals).toEqual(['SIGTERM']);
    expect(ffmpeg.signals).toEqual([]);
  });

  test('escalates to SIGINT then SIGKILL when nothing exits', async () => {
    const helper = new FakeProcess(null);
    const ffmpeg = new FakeProcess('SIGKILL');
    await stopCaptureProcesses('wasapi-loopback', [helper, ffmpeg], ffmpeg.exited, FAST);
    expect(helper.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(ffmpeg.signals).toEqual(['SIGINT', 'SIGKILL']);
  });
});
