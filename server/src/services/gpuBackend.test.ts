import { describe, expect, test, vi } from 'vitest';

import {
  classifyWhisperFailure,
  countVulkanDevices,
  describeExit,
  formatExitCode,
  GpuState,
  resolveGpuPolicy,
  runWithGpuFallback,
  STATUS_DLL_NOT_FOUND,
  type WhisperExit,
} from './gpuBackend.js';

describe('resolveGpuPolicy', () => {
  test('win32/x64 -> vulkan, gpu on, unlocked', () => {
    expect(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null })).toEqual({
      nativeBackend: 'vulkan',
      useGpu: true,
      locked: false,
    });
  });

  test('darwin/arm64 -> metal, gpu on, unlocked', () => {
    expect(resolveGpuPolicy({ platform: 'darwin', arch: 'arm64', override: null })).toEqual({
      nativeBackend: 'metal',
      useGpu: true,
      locked: false,
    });
  });

  test('darwin/x64 -> no native backend, gpu off', () => {
    expect(resolveGpuPolicy({ platform: 'darwin', arch: 'x64', override: null })).toEqual({
      nativeBackend: null,
      useGpu: false,
      locked: false,
    });
  });

  test('linux/x64 -> no native backend, gpu off', () => {
    expect(resolveGpuPolicy({ platform: 'linux', arch: 'x64', override: null })).toEqual({
      nativeBackend: null,
      useGpu: false,
      locked: false,
    });
  });

  test('override false on win32 -> locked cpu, still knows the native backend', () => {
    expect(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: false })).toEqual({
      nativeBackend: 'vulkan',
      useGpu: false,
      locked: true,
    });
  });

  test('override true on linux -> locked gpu on despite no native backend', () => {
    expect(resolveGpuPolicy({ platform: 'linux', arch: 'x64', override: true })).toEqual({
      nativeBackend: null,
      useGpu: true,
      locked: true,
    });
  });
});

const exit = (partial: Partial<WhisperExit>): WhisperExit => ({ code: 1, stderr: '', ...partial });

describe('classifyWhisperFailure -> gpu', () => {
  test('unsigned NTSTATUS STATUS_DLL_NOT_FOUND', () => {
    expect(classifyWhisperFailure(exit({ code: 3221225781 }))).toBe('gpu');
  });

  test('signed NTSTATUS STATUS_DLL_NOT_FOUND', () => {
    expect(classifyWhisperFailure(exit({ code: -1073741515 }))).toBe('gpu');
  });

  test('ggml_vulkan error on stderr', () => {
    expect(classifyWhisperFailure(exit({ code: 1, stderr: 'ggml_vulkan: Error: vkCreateInstance failed' }))).toBe('gpu');
  });

  test('vk:: exception on stderr', () => {
    const stderr = "terminate called after throwing an instance of 'vk::InitializationFailedError'\n  what():  vkCreateDevice: ErrorInitializationFailed";
    expect(classifyWhisperFailure(exit({ code: 3, stderr }))).toBe('gpu');
  });

  test('VK_ERROR_* on stderr', () => {
    expect(classifyWhisperFailure(exit({ code: 1, stderr: 'VK_ERROR_INCOMPATIBLE_DRIVER' }))).toBe('gpu');
  });

  test('no devices found', () => {
    expect(classifyWhisperFailure(exit({ code: 1, stderr: 'ggml_vulkan: No devices found.' }))).toBe('gpu');
  });

  test('missing vulkan-1.dll message', () => {
    expect(classifyWhisperFailure(exit({ code: 1, stderr: 'The code execution cannot proceed because vulkan-1.dll was not found' }))).toBe('gpu');
  });
});

describe('classifyWhisperFailure -> other', () => {
  test('ENOENT (missing binary)', () => {
    expect(classifyWhisperFailure(exit({ code: 'ENOENT', stderr: '' }))).toBe('other');
  });

  test('killed by signal, even with gpu-looking stderr', () => {
    expect(classifyWhisperFailure({ code: null, killed: true, signal: 'SIGTERM', stderr: 'ggml_vulkan: Error: something' })).toBe('other');
  });

  test('unrelated failure', () => {
    expect(classifyWhisperFailure(exit({ code: 1, stderr: 'error: failed to read audio file' }))).toBe('other');
  });

  test('healthy vulkan banner followed by an unrelated error stays other', () => {
    const stderr = 'ggml_vulkan: Found 1 Vulkan devices:\nggml_vulkan: 0 = NVIDIA GeForce RTX 4060 (NVIDIA) | uma: 0\nerror: failed to open model';
    expect(classifyWhisperFailure(exit({ code: 1, stderr }))).toBe('other');
  });

  test('STATUS_STACK_BUFFER_OVERRUN (non-ASCII path crash) stays other', () => {
    expect(classifyWhisperFailure(exit({ code: 3221226505, stderr: '' }))).toBe('other');
  });

  test('plain exit 1, empty stderr', () => {
    expect(classifyWhisperFailure(exit({ code: 1, stderr: '' }))).toBe('other');
  });
});

describe('countVulkanDevices', () => {
  test('healthy banner -> 1', () => {
    const stderr = 'ggml_vulkan: Found 1 Vulkan devices:\nggml_vulkan: 0 = NVIDIA GeForce RTX 4060 (NVIDIA) | uma: 0\noutput_json: saving output to x.json';
    expect(countVulkanDevices(stderr)).toBe(1);
  });

  test('two devices -> 2', () => {
    expect(countVulkanDevices('ggml_vulkan: Found 2 Vulkan devices:')).toBe(2);
  });

  test('zero devices -> 0', () => {
    expect(countVulkanDevices('ggml_vulkan: Found 0 Vulkan devices')).toBe(0);
  });

  test('banner absent (loader found no driver, CPU run) -> null', () => {
    expect(countVulkanDevices('output_json: saving output to x.json')).toBeNull();
    expect(countVulkanDevices('')).toBeNull();
  });
});

describe('formatExitCode', () => {
  test('unsigned NTSTATUS', () => {
    expect(formatExitCode(3221225781)).toBe('0xC0000135');
  });

  test('signed NTSTATUS', () => {
    expect(formatExitCode(-1073741515)).toBe('0xC0000135');
  });

  test('plain exit code', () => {
    expect(formatExitCode(1)).toBe('1');
  });

  test('null -> signal', () => {
    expect(formatExitCode(null)).toBe('signal');
  });
});

describe('describeExit', () => {
  test('picks the vulkan line out of multi-line stderr', () => {
    const stderr = 'some other line\nggml_vulkan: Error: vkCreateInstance failed\nmore noise';
    const description = describeExit(exit({ code: 1, stderr }));
    expect(description).toContain('exit 1');
    expect(description).toContain('ggml_vulkan: Error: vkCreateInstance failed');
  });

  test('killed starts with killed (signal)', () => {
    const description = describeExit({ code: null, killed: true, signal: 'SIGTERM', stderr: '' });
    expect(description.startsWith('killed (SIGTERM)')).toBe(true);
  });
});

describe('GpuState', () => {
  test('fresh vulkan state is unknown until confirmed', () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    expect(state.backend()).toBe('unknown');
    expect(state.useGpu()).toBe(true);
    expect(state.canFallBack()).toBe(true);
  });

  test('markGpuConfirmed flips backend to vulkan', () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    state.markGpuConfirmed();
    expect(state.backend()).toBe('vulkan');
  });

  test('markGpuUnusable flips to cpu and is idempotent', () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    expect(state.markGpuUnusable('x')).toBe(true);
    expect(state.backend()).toBe('cpu');
    expect(state.useGpu()).toBe(false);
    expect(state.canFallBack()).toBe(false);
    expect(state.fallbackReason()).toBe('x');
    expect(state.markGpuUnusable('y')).toBe(false);
    expect(state.fallbackReason()).toBe('x');
  });

  test('metal policy resolves immediately, no fallback', () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'darwin', arch: 'arm64', override: null }));
    expect(state.backend()).toBe('metal');
    expect(state.canFallBack()).toBe(false);
  });

  test('locked vulkan (override true) resolves immediately, no fallback', () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: true }));
    expect(state.backend()).toBe('vulkan');
    expect(state.canFallBack()).toBe(false);
  });

  test('override false -> cpu', () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: false }));
    expect(state.backend()).toBe('cpu');
  });

  test('describePolicy strings', () => {
    expect(new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null })).describePolicy())
      .toBe('vulkan, automatic CPU fallback');
    expect(new GpuState(resolveGpuPolicy({ platform: 'darwin', arch: 'arm64', override: null })).describePolicy())
      .toBe('metal');
    expect(new GpuState(resolveGpuPolicy({ platform: 'linux', arch: 'x64', override: null })).describePolicy())
      .toBe('off (no GPU backend for this platform)');
    expect(new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: true })).describePolicy())
      .toBe('forced on via WHISPER_USE_GPU=1 (vulkan)');
    expect(new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: false })).describePolicy())
      .toBe('forced off via WHISPER_USE_GPU=0');
  });
});

interface ThrownError extends Error {
  exit?: WhisperExit;
}

const exitOf = (e: unknown): WhisperExit | null => (e as ThrownError).exit ?? null;
const gpuError = (partial: Partial<WhisperExit> = {}) =>
  Object.assign(new Error('whisper failed'), { exit: exit({ code: 3221225781, stderr: 'ggml_vulkan: Error: vkCreateInstance failed', ...partial }) });
const otherError = (partial: Partial<WhisperExit> = {}) =>
  Object.assign(new Error('whisper failed'), { exit: exit({ code: 1, stderr: 'bad audio', ...partial }) });

describe('runWithGpuFallback', () => {
  test('gpu-class failure retries once with --no-gpu and flips state to cpu', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    const calls: boolean[] = [];
    const attempt = vi.fn(async (useGpu: boolean) => {
      calls.push(useGpu);
      if (useGpu) throw gpuError();
      return 'ok';
    });
    const log = vi.fn();
    const result = await runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' });
    expect(result).toBe('ok');
    expect(calls).toEqual([true, false]);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(state.backend()).toBe('cpu');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('--no-gpu');
  });

  test('unrelated failure is not retried', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    const attempt = vi.fn(async () => { throw otherError(); });
    const log = vi.fn();
    await expect(runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' })).rejects.toThrow('whisper failed');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.backend()).toBe('unknown');
    expect(log).not.toHaveBeenCalled();
  });

  test('after a flip, a later call runs attempt(false) exactly once', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    state.markGpuUnusable('previous failure');
    const attempt = vi.fn(async (useGpu: boolean) => { expect(useGpu).toBe(false); return 'ok'; });
    const log = vi.fn();
    const result = await runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test('retry also failing rethrows the retry error', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    const attempt = vi.fn(async (useGpu: boolean) => {
      if (useGpu) throw gpuError();
      throw otherError({ stderr: 'still broken' });
    });
    const log = vi.fn();
    await expect(runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' })).rejects.toThrow('whisper failed');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(state.backend()).toBe('cpu');
  });

  test('exitOf returning null throws through untouched', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    const attempt = vi.fn(async () => { throw new Error('not a whisper exit'); });
    const log = vi.fn();
    await expect(runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' })).rejects.toThrow('not a whisper exit');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test('metal state: gpu-class-looking failure is thrown through', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'darwin', arch: 'arm64', override: null }));
    const attempt = vi.fn(async () => { throw gpuError(); });
    const log = vi.fn();
    await expect(runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' })).rejects.toThrow('whisper failed');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.backend()).toBe('metal');
  });

  test('locked vulkan (override true): gpu-class failure is thrown through', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: true }));
    const attempt = vi.fn(async () => { throw gpuError(); });
    const log = vi.fn();
    await expect(runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' })).rejects.toThrow('whisper failed');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test('successful gpu attempt confirms the backend', async () => {
    const state = new GpuState(resolveGpuPolicy({ platform: 'win32', arch: 'x64', override: null }));
    const attempt = vi.fn(async () => 'ok');
    const log = vi.fn();
    const result = await runWithGpuFallback(state, attempt, { exitOf, log, label: 'job' });
    expect(result).toBe('ok');
    expect(state.backend()).toBe('vulkan');
  });
});
