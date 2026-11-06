import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/// AUG-198: finds and probes the Claude Code CLI (version + login) for Settings → AI assistants.
/// Paths, e-mail and plan never leave this module: the client only sees ClaudeProbe.

export const AI_MIN_CLAUDE_VERSION = '2.1.318';

export interface ResolvedClaudeCli {
  path: string;
  shim: boolean;
}

export interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  canExecute: (p: string) => Promise<boolean>;
  lookup: () => Promise<string[]>;
}

export function defaultResolveDeps(): ResolveDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    canExecute: async (p) => {
      try {
        await fs.access(p, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    lookup: () =>
      new Promise<string[]>((resolve) => {
        const cb = (err: Error | null, stdout: string | Buffer) => {
          if (err) {
            resolve([]);
            return;
          }
          resolve(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
        };
        try {
          if (process.platform === 'win32') {
            execFile('where', ['claude'], { windowsHide: true, timeout: 5000 }, cb);
          } else {
            execFile('/usr/bin/which', ['claude'], { timeout: 5000 }, cb);
          }
        } catch {
          resolve([]);
        }
      }),
  };
}

function isShim(platform: NodeJS.Platform, p: string): boolean {
  return platform === 'win32' && /\.cmd$/i.test(p);
}

export async function resolveClaudeCli(deps: ResolveDeps = defaultResolveDeps()): Promise<ResolvedClaudeCli | null> {
  const win = deps.platform === 'win32';
  const p = win ? path.win32 : path.posix;

  const override = deps.env.CLAUDE_CLI_PATH?.trim();
  if (override && p.isAbsolute(override)) return { path: override, shim: isShim(deps.platform, override) };

  if (win) {
    const candidates = [p.join(deps.homedir, '.local', 'bin', 'claude.exe')];
    if (deps.env.APPDATA) candidates.push(p.join(deps.env.APPDATA, 'npm', 'claude.cmd'));
    for (const c of candidates) {
      if (await deps.canExecute(c)) return { path: c, shim: isShim(deps.platform, c) };
    }
    for (const line of await deps.lookup()) {
      if (/\.exe$/i.test(line) && (await deps.canExecute(line))) return { path: line, shim: false };
    }
    return null;
  }

  // darwin (linux behaves the same)
  const candidates = [p.join(deps.homedir, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of candidates) {
    if (await deps.canExecute(c)) return { path: c, shim: false };
  }
  for (const line of await deps.lookup()) {
    if (await deps.canExecute(line)) return { path: line, shim: false };
  }
  return null;
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/// Billing goes to the login, not to an API key that happens to be in the environment (findings §4.4).
export function buildClaudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

/// Never rejects. `args` are fixed literals from this module, never user input (the .cmd shim path is joined into a command line).
export function runClaudeCli(cli: ResolvedClaudeCli, args: string[], timeoutMs = 10_000): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve) => {
    const opts = {
      cwd: os.homedir(),
      env: buildClaudeEnv(),
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8' as const,
      maxBuffer: 1024 * 1024,
    };
    const cb = (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: !!err && err.killed === true,
      });
    };
    try {
      if (cli.shim) {
        execFile(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', `""${cli.path}" ${args.join(' ')}"`],
          { ...opts, windowsVerbatimArguments: true },
          cb,
        );
      } else {
        execFile(cli.path, args, opts, cb);
      }
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e), timedOut: false });
    }
  });
}

export function parseClaudeVersion(stdout: string): string | null {
  return /^\s*(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export interface AuthParse {
  signedIn: boolean;
  authMethod: string | null;
  unknownCommand: boolean;
}

/// `claude auth status` exits 1 when logged out but still prints JSON, so stdout is parsed regardless of the exit code.
/// Only loggedIn / authMethod are kept; e-mail, org, plan and directories are dropped.
export function parseAuthStatus(r: CliRunResult): AuthParse {
  if (/unknown command/i.test(`${r.stdout}\n${r.stderr}`)) {
    return { signedIn: false, authMethod: null, unknownCommand: true };
  }
  try {
    const parsed: unknown = JSON.parse(r.stdout.trim());
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      return {
        signedIn: o.loggedIn === true,
        authMethod: typeof o.authMethod === 'string' ? o.authMethod : null,
        unknownCommand: false,
      };
    }
  } catch {
    // fall through
  }
  return { signedIn: false, authMethod: null, unknownCommand: false };
}

export interface ClaudeProbe {
  found: boolean;
  signedIn: boolean;
  version: string | null;
  tooOld: boolean;
  checkedAt: string;
}

export interface ProbeDeps {
  resolve: () => Promise<ResolvedClaudeCli | null>;
  run: (cli: ResolvedClaudeCli, args: string[]) => Promise<CliRunResult>;
  now: () => Date;
  log: (msg: string) => void;
}

let lastResolved: ResolvedClaudeCli | null = null;

/// Server-internal (for the later session child); never sent to the client.
export function getResolvedClaudeCli(): ResolvedClaudeCli | null {
  return lastResolved;
}

export async function probeClaudeCli(deps: Partial<ProbeDeps> = {}): Promise<ClaudeProbe> {
  const resolve = deps.resolve ?? (() => resolveClaudeCli());
  const run = deps.run ?? ((cli, args) => runClaudeCli(cli, args));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string) => console.log(msg));

  let found = false;
  let signedIn = false;
  let version: string | null = null;
  let tooOld = false;
  let authMethod: string | null = null;

  try {
    const cli = await resolve();
    if (cli) {
      const v = await run(cli, ['--version']);
      version = v.code === 0 ? parseClaudeVersion(v.stdout) : null;
      if (version) {
        found = true;
        lastResolved = cli;
        if (compareVersions(version, AI_MIN_CLAUDE_VERSION) < 0) {
          // An old build could treat `auth status` as a prompt, so it is never run.
          tooOld = true;
        } else {
          const a = parseAuthStatus(await run(cli, ['auth', 'status']));
          authMethod = a.authMethod;
          if (a.unknownCommand) tooOld = true;
          else signedIn = a.signedIn;
        }
      }
    }
  } catch {
    found = false;
    signedIn = false;
    tooOld = false;
  }

  log(`[claudeCli] probe: found=${found} version=${version ?? '-'} tooOld=${tooOld} loggedIn=${signedIn} authMethod=${authMethod ?? '-'}`);
  return { found, signedIn, version, tooOld, checkedAt: now().toISOString() };
}

let cached: Promise<ClaudeProbe> | null = null;
let inFlight = false;

/// Lazy: nothing runs until the first status request. `recheck` re-runs the probe unless one is already in flight.
export function getClaudeProbe(recheck = false): Promise<ClaudeProbe> {
  if (cached && (!recheck || inFlight)) return cached;
  inFlight = true;
  cached = probeClaudeCli().finally(() => {
    inFlight = false;
  });
  return cached;
}

export function resetClaudeProbeCache(): void {
  cached = null;
}
