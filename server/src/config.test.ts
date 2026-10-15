import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { parseGpuEngine, parseGpuOverride, resolveAudioteePath, resolveFfmpegPaths } from './config.js';

const winName = (tool: 'ffmpeg' | 'ffprobe') => `${tool}.exe`;
const existsIn = (files: string[]) => (filePath: string) => files.includes(filePath);

describe('resolveFfmpegPaths (AUG-115)', () => {
  const bundledDir = path.join('repo', 'whisper', 'bin', 'win-x64');
  const bundledFfmpeg = path.join(bundledDir, 'ffmpeg.exe');
  const bundledFfprobe = path.join(bundledDir, 'ffprobe.exe');

  test('FFMPEG_PATH wins over the bundled binary and brings its sibling ffprobe', () => {
    const custom = path.resolve('tools', 'ffmpeg.exe');
    const customProbe = path.join(path.dirname(custom), 'ffprobe.exe');
    const r = resolveFfmpegPaths({
      envPath: custom,
      bundledDirs: [bundledDir],
      exists: existsIn([bundledFfmpeg, bundledFfprobe, custom, customProbe]),
      binName: winName,
    });
    expect(r).toEqual({ ffmpeg: custom, ffprobe: customProbe, source: 'env' });
  });

  test('env ffmpeg without a sibling ffprobe falls back to ffprobe on PATH', () => {
    const custom = path.resolve('tools', 'ffmpeg.exe');
    const r = resolveFfmpegPaths({ envPath: custom, bundledDirs: [bundledDir], exists: existsIn([custom, bundledFfmpeg]), binName: winName });
    expect(r).toEqual({ ffmpeg: custom, ffprobe: 'ffprobe.exe', source: 'env' });
  });

  test('bundled ffmpeg next to whisper-cli is used when FFMPEG_PATH is unset', () => {
    const r = resolveFfmpegPaths({ envPath: undefined, bundledDirs: [bundledDir], exists: existsIn([bundledFfmpeg, bundledFfprobe]), binName: winName });
    expect(r).toEqual({ ffmpeg: bundledFfmpeg, ffprobe: bundledFfprobe, source: 'bundled' });
  });

  test('the first bundled directory that holds ffmpeg wins', () => {
    const otherDir = path.join('custom', 'bin');
    const r = resolveFfmpegPaths({ envPath: '', bundledDirs: [otherDir, bundledDir], exists: existsIn([bundledFfmpeg]), binName: winName });
    expect(r.ffmpeg).toBe(bundledFfmpeg);
    expect(r.source).toBe('bundled');
  });

  test('blank FFMPEG_PATH is treated as unset', () => {
    const r = resolveFfmpegPaths({ envPath: '   ', bundledDirs: [bundledDir], exists: existsIn([bundledFfmpeg]), binName: winName });
    expect(r.source).toBe('bundled');
  });

  test('falls back to bare PATH names when nothing is bundled', () => {
    const r = resolveFfmpegPaths({ envPath: undefined, bundledDirs: [bundledDir], exists: () => false, binName: winName });
    expect(r).toEqual({ ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe', source: 'path' });
  });

  test('uses the unsuffixed names on non-Windows', () => {
    const r = resolveFfmpegPaths({ envPath: undefined, bundledDirs: [], exists: () => false, binName: (tool) => tool });
    expect(r).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'path' });
  });
});

describe('resolveAudioteePath (AUG-118)', () => {
  const bundledDir = path.join('repo', 'whisper', 'bin', 'darwin-arm64');
  const bundledAudiotee = path.join(bundledDir, 'audiotee');

  test('AUDIOTEE_PATH wins over the bundled binary', () => {
    const custom = path.resolve('tools', 'audiotee');
    const r = resolveAudioteePath({ envPath: custom, bundledDirs: [bundledDir], exists: existsIn([bundledAudiotee, custom]) });
    expect(r).toEqual({ path: custom, source: 'env' });
  });

  test('bundled audiotee next to whisper-cli is used when AUDIOTEE_PATH is unset', () => {
    const r = resolveAudioteePath({ envPath: undefined, bundledDirs: [bundledDir], exists: existsIn([bundledAudiotee]) });
    expect(r).toEqual({ path: bundledAudiotee, source: 'bundled' });
  });

  test('the first bundled directory that holds audiotee wins', () => {
    const otherDir = path.join('custom', 'bin');
    const r = resolveAudioteePath({ envPath: '', bundledDirs: [otherDir, bundledDir], exists: existsIn([bundledAudiotee]) });
    expect(r.path).toBe(bundledAudiotee);
    expect(r.source).toBe('bundled');
  });

  test('blank AUDIOTEE_PATH is treated as unset', () => {
    const r = resolveAudioteePath({ envPath: '   ', bundledDirs: [bundledDir], exists: existsIn([bundledAudiotee]) });
    expect(r.source).toBe('bundled');
  });

  test('falls back to bare PATH name when nothing is bundled', () => {
    const r = resolveAudioteePath({ envPath: undefined, bundledDirs: [bundledDir], exists: () => false });
    expect(r).toEqual({ path: 'audiotee', source: 'path' });
  });
});

describe('parseGpuOverride (AUG-116)', () => {
  test('recognises on/off spellings', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ']) expect(parseGpuOverride(v)).toBe(true);
    for (const v of ['0', 'false', 'off', 'no', ' Off ']) expect(parseGpuOverride(v)).toBe(false);
  });
  test('unset, blank or unknown values mean no override', () => {
    expect(parseGpuOverride(undefined)).toBeNull();
    expect(parseGpuOverride('')).toBeNull();
    expect(parseGpuOverride('   ')).toBeNull();
    expect(parseGpuOverride('auto')).toBeNull();
  });
});

describe('parseGpuEngine (AUG-136)', () => {
  test('recognises cuda', () => {
    expect(parseGpuEngine('cuda')).toBe('cuda');
    expect(parseGpuEngine(' CUDA ')).toBe('cuda');
  });
  test('anything else defaults to cpu', () => {
    expect(parseGpuEngine(undefined)).toBe('cpu');
    expect(parseGpuEngine('')).toBe('cpu');
    expect(parseGpuEngine('vulkan')).toBe('cpu');
  });
});
