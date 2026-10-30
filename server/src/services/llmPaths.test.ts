import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { buildLlamaServerArgs, llamaServerPath, llmGpuLayers } from './llmPaths.js';

describe('buildLlamaServerArgs (AUG-162)', () => {
  test('binds loopback only with the expected flags', () => {
    expect(buildLlamaServerArgs({ modelPath: 'm.gguf', port: 5050, gpuLayers: 99, contextSize: 4096, alias: 'qwen' })).toEqual([
      '-m', 'm.gguf', '--host', '127.0.0.1', '--port', '5050', '-ngl', '99', '-c', '4096', '-np', '1', '--no-webui', '--alias', 'qwen',
    ]);
  });
});

describe('llmGpuLayers (AUG-162)', () => {
  test('override wins, including 0 and 7', () => {
    expect(llmGpuLayers({ variant: 'darwin-arm64', override: 0, customBinary: true })).toBe(0);
    expect(llmGpuLayers({ variant: 'win-x64-cuda', override: 7, customBinary: false })).toBe(7);
  });
  test('custom binary offloads fully', () => {
    expect(llmGpuLayers({ variant: 'win-x64', override: null, customBinary: true })).toBe(99);
  });
  test('Metal and CUDA builds offload fully', () => {
    expect(llmGpuLayers({ variant: 'darwin-arm64', override: null, customBinary: false })).toBe(99);
    expect(llmGpuLayers({ variant: 'win-x64-cuda', override: null, customBinary: false })).toBe(99);
  });
  test('CPU builds and unknown variants stay on CPU', () => {
    expect(llmGpuLayers({ variant: 'win-x64', override: null, customBinary: false })).toBe(0);
    expect(llmGpuLayers({ variant: 'darwin-x64', override: null, customBinary: false })).toBe(0);
    expect(llmGpuLayers({ variant: null, override: null, customBinary: false })).toBe(0);
  });
});

describe('llamaServerPath (AUG-162)', () => {
  const root = path.join('data', 'llm');
  test('Windows binary has the .exe suffix', () => {
    expect(llamaServerPath(root, 'win-x64', 'win32')).toBe(path.join(root, 'bin', 'win-x64', 'llama-server.exe'));
  });
  test('macOS binary has no suffix', () => {
    expect(llamaServerPath(root, 'darwin-arm64', 'darwin')).toBe(path.join(root, 'bin', 'darwin-arm64', 'llama-server'));
  });
});
