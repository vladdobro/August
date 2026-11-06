import { describe, expect, test, vi } from 'vitest';

import {
  buildClaudeEnv,
  compareVersions,
  parseAuthStatus,
  parseClaudeVersion,
  probeClaudeCli,
  resolveClaudeCli,
  type CliRunResult,
  type ResolveDeps,
} from './claudeCli.js';

function deps(over: Partial<ResolveDeps> & { existing?: string[]; lookupLines?: string[] }): ResolveDeps {
  const existing = new Set(over.existing ?? []);
  return {
    platform: over.platform ?? 'win32',
    env: over.env ?? {},
    homedir: over.homedir ?? 'C:\\Users\\Влад',
    canExecute: async (p) => existing.has(p),
    lookup: async () => over.lookupLines ?? [],
  };
}

describe('resolveClaudeCli win32', () => {
  const home = 'C:\\Users\\Влад';
  const native = `${home}\\.local\\bin\\claude.exe`;

  test('CLAUDE_CLI_PATH wins without an access check', async () => {
    const r = await resolveClaudeCli(deps({ env: { CLAUDE_CLI_PATH: 'D:\\tools\\claude.exe' }, existing: [native] }));
    expect(r).toEqual({ path: 'D:\\tools\\claude.exe', shim: false });
  });

  test('native installer path with a Cyrillic home dir', async () => {
    const r = await resolveClaudeCli(deps({ existing: [native] }));
    expect(r).toEqual({ path: native, shim: false });
  });

  test('falls back to %APPDATA%\\npm\\claude.cmd as a shim', async () => {
    const cmd = 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd';
    const r = await resolveClaudeCli(deps({ env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, existing: [cmd] }));
    expect(r).toEqual({ path: cmd, shim: true });
  });

  test('falls back to the first .exe line of where, skipping non-.exe lines', async () => {
    const exe = 'C:\\bin\\claude.exe';
    const r = await resolveClaudeCli(deps({ lookupLines: ['C:\\bin\\claude', exe], existing: ['C:\\bin\\claude', exe] }));
    expect(r).toEqual({ path: exe, shim: false });
  });

  test('nothing found -> null', async () => {
    expect(await resolveClaudeCli(deps({}))).toBeNull();
  });
});

describe('resolveClaudeCli darwin', () => {
  const home = '/Users/vlad';
  const base = { platform: 'darwin' as const, homedir: home };

  test('~/.local/bin first', async () => {
    const r = await resolveClaudeCli(deps({ ...base, existing: [`${home}/.local/bin/claude`, '/opt/homebrew/bin/claude'] }));
    expect(r).toEqual({ path: `${home}/.local/bin/claude`, shim: false });
  });

  test('then homebrew, then /usr/local, then which', async () => {
    expect((await resolveClaudeCli(deps({ ...base, existing: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'] })))?.path).toBe('/opt/homebrew/bin/claude');
    expect((await resolveClaudeCli(deps({ ...base, existing: ['/usr/local/bin/claude'] })))?.path).toBe('/usr/local/bin/claude');
    const r = await resolveClaudeCli(deps({ ...base, lookupLines: ['/somewhere/claude'], existing: ['/somewhere/claude'] }));
    expect(r).toEqual({ path: '/somewhere/claude', shim: false });
  });

  test('nothing found -> null; shim is never set', async () => {
    expect(await resolveClaudeCli(deps(base))).toBeNull();
    const r = await resolveClaudeCli(deps({ ...base, env: { CLAUDE_CLI_PATH: '/x/claude.cmd' } }));
    expect(r?.shim).toBe(false);
  });
});

describe('versions', () => {
  test('parseClaudeVersion', () => {
    expect(parseClaudeVersion('2.1.319 (Claude Code)')).toBe('2.1.319');
    expect(parseClaudeVersion('garbage')).toBeNull();
  });
  test('compareVersions', () => {
    expect(compareVersions('2.1.318', '2.1.319')).toBe(-1);
    expect(compareVersions('2.1.318', '2.0.14')).toBe(1);
    expect(compareVersions('2.1.318', '2.1.318')).toBe(0);
    expect(compareVersions('2.1.318', '10.0.0')).toBe(-1);
  });
});

const run = (code: number | null, stdout: string, stderr = ''): CliRunResult => ({ code, stdout, stderr, timedOut: false });

describe('parseAuthStatus', () => {
  test('logged in', () => {
    const r = parseAuthStatus(run(0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: 'X' })));
    expect(r).toEqual({ signedIn: true, authMethod: 'claude.ai', unknownCommand: false });
    expect(Object.keys(r)).not.toContain('email');
    expect(Object.keys(r)).not.toContain('orgName');
  });
  test('logged out exits 1 but prints JSON', () => {
    const out = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"x","configDirectory":"y","loginExpiresAt":null}';
    expect(parseAuthStatus(run(1, out))).toEqual({ signedIn: false, authMethod: 'none', unknownCommand: false });
  });
  test('unknown command', () => {
    const r = parseAuthStatus(run(1, '', '✘ unknown command "authx"\n  └ Did you mean claude auth?'));
    expect(r.unknownCommand).toBe(true);
    expect(r.signedIn).toBe(false);
  });
  test('non-JSON', () => {
    expect(parseAuthStatus(run(0, 'hello'))).toEqual({ signedIn: false, authMethod: null, unknownCommand: false });
  });
});

describe('buildClaudeEnv', () => {
  test('strips API credentials and keeps the rest', () => {
    const out = buildClaudeEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin', HOME: '/h' });
    expect(out).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('probeClaudeCli', () => {
  const cli = { path: 'C:\\secret\\path\\claude.exe', shim: false };
  const now = () => new Date('2026-11-06T10:00:00Z');

  function setup(results: Record<string, CliRunResult>, found = true) {
    const logs: string[] = [];
    const runFn = vi.fn(async (_c: unknown, args: string[]) => results[args.join(' ')] ?? run(1, ''));
    const p = probeClaudeCli({ resolve: async () => (found ? cli : null), run: runFn, now, log: (m) => logs.push(m) });
    return { p, runFn, logs };
  }

  test('not found', async () => {
    const { p } = setup({}, false);
    expect(await p).toEqual({ found: false, signedIn: false, version: null, tooOld: false, checkedAt: '2026-11-06T10:00:00.000Z' });
  });

  test('too old version skips auth status', async () => {
    const { p, runFn } = setup({ '--version': run(0, '2.0.14 (Claude Code)') });
    const r = await p;
    expect(r).toMatchObject({ found: true, signedIn: false, version: '2.0.14', tooOld: true });
    expect(runFn.mock.calls.some((c) => c[1][0] === 'auth')).toBe(false);
  });

  test('unknown auth command -> tooOld', async () => {
    const { p } = setup({ '--version': run(0, '2.1.319 (Claude Code)'), 'auth status': run(1, '', 'unknown command "auth"') });
    expect(await p).toMatchObject({ found: true, signedIn: false, tooOld: true });
  });

  test('signed in', async () => {
    const { p, logs } = setup({ '--version': run(0, '2.1.319 (Claude Code)'), 'auth status': run(0, '{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}') });
    expect(await p).toMatchObject({ found: true, signedIn: true, version: '2.1.319', tooOld: false });
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/email|secret|a@b\.c/i);
  });

  test('logged out', async () => {
    const { p } = setup({ '--version': run(0, '2.1.319 (Claude Code)'), 'auth status': run(1, '{"loggedIn":false,"authMethod":"none"}') });
    expect(await p).toMatchObject({ found: true, signedIn: false, tooOld: false });
  });
});
