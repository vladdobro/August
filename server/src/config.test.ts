import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  findLlmModel,
  LLAMA_CPP_BUILDS,
  LLAMA_CPP_VERSION,
  llamaServerBinName,
  llmCpuVariantDir,
  llmVariantDir,
  parseGpuEngine,
  parseGpuOverride,
  parseLlmGpuLayers,
  parseLlmIdleMinutes,
  resolveAudioteePath,
  resolveFfmpegPaths,
  resolveLlmRoot,
} from './config.js';

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

describe('local LLM config (AUG-162)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  test('llamaServerBinName follows the platform', () => {
    expect(llamaServerBinName('win32')).toBe('llama-server.exe');
    expect(llamaServerBinName('darwin')).toBe('llama-server');
  });

  test('llamaServerBinName defaults to process.platform', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(llamaServerBinName()).toBe('llama-server.exe');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(llamaServerBinName()).toBe('llama-server');
  });

  test('llmVariantDir picks the build per platform and engine', () => {
    expect(llmVariantDir({ platform: 'win32', arch: 'x64', gpuEngine: 'cpu' })).toBe('win-x64');
    expect(llmVariantDir({ platform: 'win32', arch: 'x64', gpuEngine: 'cuda' })).toBe('win-x64-cuda');
    expect(llmVariantDir({ platform: 'darwin', arch: 'arm64', gpuEngine: 'cuda' })).toBe('darwin-arm64');
    expect(llmVariantDir({ platform: 'darwin', arch: 'x64', gpuEngine: 'cpu' })).toBe('darwin-x64');
    expect(llmVariantDir({ platform: 'linux', arch: 'x64', gpuEngine: 'cpu' })).toBeNull();
    expect(llmVariantDir({ platform: 'win32', arch: 'arm64', gpuEngine: 'cpu' })).toBeNull();
  });

  test('llmCpuVariantDir never returns the CUDA build', () => {
    expect(llmCpuVariantDir({ platform: 'win32', arch: 'x64' })).toBe('win-x64');
    expect(llmCpuVariantDir({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64');
    expect(llmCpuVariantDir({ platform: 'linux', arch: 'x64' })).toBeNull();
  });

  test('LLAMA_CPP_BUILDS urls carry the pinned version and the right archive type', () => {
    for (const [variant, build] of Object.entries(LLAMA_CPP_BUILDS)) {
      expect(build.url).toContain(LLAMA_CPP_VERSION);
      expect(build.url.endsWith(variant.startsWith('win') ? '.zip' : '.tar.gz')).toBe(true);
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('findLlmModel resolves known ids only', () => {
    expect(findLlmModel('qwen2.5-3b-instruct-q4km')?.label).toBe('Qwen2.5 3B');
    expect(findLlmModel('nope')).toBeNull();
    expect(findLlmModel(undefined)).toBeNull();
  });

  test('parseLlmGpuLayers accepts non-negative integers only', () => {
    expect(parseLlmGpuLayers('')).toBeNull();
    expect(parseLlmGpuLayers('abc')).toBeNull();
    expect(parseLlmGpuLayers('-1')).toBeNull();
    expect(parseLlmGpuLayers('0')).toBe(0);
    expect(parseLlmGpuLayers('33')).toBe(33);
  });

  test('parseLlmIdleMinutes needs a positive number, otherwise 10', () => {
    expect(parseLlmIdleMinutes(undefined)).toBe(10);
    expect(parseLlmIdleMinutes('2')).toBe(2);
    expect(parseLlmIdleMinutes('0')).toBe(10);
    expect(parseLlmIdleMinutes('x')).toBe(10);
  });

  describe('resolveLlmRoot', () => {
    const dataDir = path.resolve('data-dir');
    const defaultRoot = path.join(dataDir, 'llm');

    test('LLM_ROOT env wins and pins the root', () => {
      const env = path.resolve('pinned', 'llm');
      const r = resolveLlmRoot({ envRoot: `  ${env}  `, persistedRoot: path.resolve('other'), dataDir });
      expect(r).toEqual({ root: env, pinned: true, isDefault: false });
    });

    test('a remembered absolute path is used', () => {
      const saved = path.resolve('drive', 'August LLM');
      expect(resolveLlmRoot({ envRoot: undefined, persistedRoot: saved, dataDir })).toEqual({ root: saved, pinned: false, isDefault: false });
    });

    test('a remembered path equal to the default counts as default', () => {
      expect(resolveLlmRoot({ envRoot: '', persistedRoot: defaultRoot, dataDir })).toEqual({ root: defaultRoot, pinned: false, isDefault: true });
    });

    test('relative, non-string or empty remembered values fall back to the default', () => {
      for (const persistedRoot of ['relative/path', 42, '', '   ', null, undefined]) {
        expect(resolveLlmRoot({ envRoot: undefined, persistedRoot, dataDir })).toEqual({ root: defaultRoot, pinned: false, isDefault: true });
      }
    });
  });
});
