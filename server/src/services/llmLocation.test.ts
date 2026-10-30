import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { targetRootFor, validateRelocation } from './llmLocation.js';

describe('targetRootFor (AUG-162 model folder)', () => {
  const dataDir = path.resolve('data-dir');

  test('null maps to the default root', () => {
    expect(targetRootFor(null, dataDir)).toBe(path.join(dataDir, 'llm'));
  });

  test('a picked folder gets the August LLM subfolder', () => {
    const picked = path.resolve('models-drive');
    expect(targetRootFor(picked, dataDir)).toBe(path.join(picked, 'August LLM'));
  });
});

describe('validateRelocation', () => {
  test('a relative target is rejected', () => {
    expect(validateRelocation('/a/llm', 'relative/dir', 'linux')).not.toBeNull();
  });

  test('the same folder is a no-op, not an error', () => {
    expect(validateRelocation('/a/llm', '/a/llm', 'linux')).toBeNull();
  });

  test('a target inside the current root is rejected', () => {
    expect(validateRelocation('/a/llm', '/a/llm/sub', 'darwin')).not.toBeNull();
  });

  test('a current root inside the target is rejected', () => {
    expect(validateRelocation('/a/llm/x', '/a/llm', 'darwin')).not.toBeNull();
  });

  test('a sibling folder is accepted', () => {
    expect(validateRelocation('/a/llm', '/a/llm2', 'darwin')).toBeNull();
    expect(validateRelocation(String.raw`C:\A\llm`, String.raw`D:\llm`, 'win32')).toBeNull();
  });

  test('win32 compares case-insensitively', () => {
    expect(validateRelocation(String.raw`C:\A\llm`, String.raw`c:\a\llm\x`, 'win32')).not.toBeNull();
    expect(validateRelocation(String.raw`c:\a\llm\x`, String.raw`C:\A\llm`, 'win32')).not.toBeNull();
  });

  test('posix compares case-sensitively', () => {
    expect(validateRelocation('/a/llm', '/A/llm/x', 'darwin')).toBeNull();
  });
});
