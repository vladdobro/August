import { describe, test, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  BUILT_IN_PROMPT,
  resolvePraxisPrompt,
  applyPromptVariables,
  formatDurationForPrompt,
} from './praxisIntegration.js';

const root = path.join(os.tmpdir(), 'august-praxis-test');
const proj = path.join(root, 'proj');

describe('resolvePraxisPrompt', () => {
  test('project prompt wins', () => {
    const prefs = {
      praxisProjects: [{ path: proj, name: 'p', isDefault: true, prompt: 'PROJECT' }],
      praxisDefaultPrompt: 'DEFAULT',
    };
    expect(resolvePraxisPrompt(prefs, proj)).toEqual({ prompt: 'PROJECT', source: 'project' });
  });

  test('blank project prompt falls back to default', () => {
    const prefs = {
      praxisProjects: [{ path: proj, name: 'p', isDefault: true, prompt: '   ' }],
      praxisDefaultPrompt: 'DEFAULT',
    };
    expect(resolvePraxisPrompt(prefs, proj)).toEqual({ prompt: 'DEFAULT', source: 'default' });
  });

  test('no default falls back to built-in', () => {
    const prefs = { praxisProjects: [{ path: proj, name: 'p', isDefault: true }], praxisDefaultPrompt: '  ' };
    expect(resolvePraxisPrompt(prefs, proj)).toEqual({ prompt: BUILT_IN_PROMPT, source: 'built-in' });
    expect(resolvePraxisPrompt({}, proj).source).toBe('built-in');
  });

  test('path match is case-insensitive and tolerant of trailing separator', () => {
    const prefs = { praxisProjects: [{ path: proj, name: 'p', isDefault: true, prompt: 'PROJECT' }] };
    expect(resolvePraxisPrompt(prefs, proj + path.sep).source).toBe('project');
    expect(resolvePraxisPrompt(prefs, proj.toUpperCase()).source).toBe('project');
  });
});

describe('applyPromptVariables', () => {
  const vars = { sessionName: 'Weekly', date: '2026-10-22', duration: '5m 3s' };

  test('replaces all three variables', () => {
    expect(applyPromptVariables('{sessionName} / {date} / {duration}', vars)).toBe('Weekly / 2026-10-22 / 5m 3s');
  });

  test('leaves unknown tokens alone', () => {
    expect(applyPromptVariables('{unknown} {date}', vars)).toBe('{unknown} 2026-10-22');
  });

  test('replaces repeated tokens', () => {
    expect(applyPromptVariables('{date} {date}', vars)).toBe('2026-10-22 2026-10-22');
  });
});

describe('formatDurationForPrompt', () => {
  test('formats seconds, minutes, hours', () => {
    expect(formatDurationForPrompt(0)).toBe('0s');
    expect(formatDurationForPrompt(65)).toBe('1m 5s');
    expect(formatDurationForPrompt(3700)).toBe('1h 1m');
  });
});
