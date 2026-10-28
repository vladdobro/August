import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { ensureWav } from './whisper.js';
import { config } from '../config.js';
import { VIDEO_NO_AUDIO_MESSAGE, VIDEO_UNREADABLE_MESSAGE } from './mediaFormats.js';

type Cb = (error: unknown, stdout: string, stderr: string) => void;
const execMock = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;

let dir: string;
let probeReply: { error: unknown; stdout: string; stderr: string };

function ffmpegCalls(): string[][] {
  return execMock.mock.calls.filter((c) => c[0] === config.ffmpegPath).map((c) => c[1] as string[]);
}
function probeCalls() {
  return execMock.mock.calls.filter((c) => c[0] === config.ffprobePath);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aug144-'));
  probeReply = { error: null, stdout: '1\n', stderr: '' };
  execMock.mockReset();
  execMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Cb) => {
    if (cmd === config.ffprobePath) {
      cb(probeReply.error, probeReply.stdout, probeReply.stderr);
    } else {
      // Synchronous so the mocked ffmpeg has written its output before the callback fires.
      writeFileSync(args[args.length - 1], Buffer.alloc(100));
      cb(null, '', '');
    }
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});


async function makeSource(name: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, Buffer.from('not-really-media'));
  return p;
}

describe('ensureWav with video containers (AUG-144)', () => {
  test('extracts audio with -vn to 16 kHz mono', async () => {
    const src = await makeSource('audio.mp4');
    const result = await ensureWav(src);
    expect(result).toBe(path.join(dir, 'audio.wav'));
    const args = ffmpegCalls()[0];
    expect(args).toEqual(expect.arrayContaining(['-vn', '-ar', '16000', '-ac', '1']));
    await expect(fs.access(result)).resolves.toBeUndefined();
  });

  test('uppercase extension is stripped from the wav name', async () => {
    const src = await makeSource('clip.MOV');
    expect(await ensureWav(src)).toBe(path.join(dir, 'clip.wav'));
  });

  test('no audio stream', async () => {
    const src = await makeSource('silent.mp4');
    probeReply = { error: null, stdout: '', stderr: '' };
    await expect(ensureWav(src)).rejects.toThrow(VIDEO_NO_AUDIO_MESSAGE);
    expect(ffmpegCalls()).toHaveLength(0);
    await expect(fs.access(src)).resolves.toBeUndefined();
  });

  test('corrupt container', async () => {
    const src = await makeSource('broken.mov');
    probeReply = { error: Object.assign(new Error('x'), { code: 1 }), stdout: '', stderr: 'moov atom not found' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ensureWav(src)).rejects.toThrow(VIDEO_UNREADABLE_MESSAGE);
    await expect(fs.access(src)).resolves.toBeUndefined();
  });

  test('audio file skips probe', async () => {
    const src = await makeSource('audio.mp3');
    await ensureWav(src);
    expect(probeCalls()).toHaveLength(0);
    expect(ffmpegCalls()[0]).not.toContain('-vn');
  });
});
