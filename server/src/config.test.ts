import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { parseGpuOverride, resolveFfmpegPaths } from './config.js';

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
