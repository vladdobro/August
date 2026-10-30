import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import {
  config,
  LLM_CONTEXT_SIZE,
  llmCpuVariantDir,
  llmVariantDir,
  type LlmModelId,
  type LlmVariantDir,
} from '../config.js';
import { createLlmClient, type LlmClient } from './llmClient.js';
import { llamaBuildInstalled, llamaServerPath, llmGpuLayers, llmModelPath, buildLlamaServerArgs } from './llmPaths.js';
import { LLM_LOCATION_UNAVAILABLE_MESSAGE, isLlmRelocating, llmLocationAvailable } from './llmLocation.js';
import { llmInstallState, readLlmSettings } from './llmInstaller.js';
import { toSafePath } from './whisper.js';

/// Owns the single llama-server child process of the opt-in local language model (AUG-162): started on demand, stopped
/// after LLM_IDLE_MINUTES without requests, killed on app exit. Ports, pids and paths stay in the log, never in the UI.
export type LlmRuntimeState = 'stopped' | 'starting' | 'running';

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 300;
const LOG_TAIL_LINES = 40;

let child: ChildProcess | null = null;
let state: LlmRuntimeState = 'stopped';
let runningModelId: LlmModelId | null = null;
let runningBaseURL: string | null = null;
let startPromise: Promise<{ baseURL: string; modelId: LlmModelId }> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = 0;

/// Lives in the data dir, not the LLM root: the root may sit on a removable drive chosen by the user.
function pidFilePath(): string {
  return path.join(config.dataDir, 'llama-server.pid');
}

/// Where the previous build kept the pid file; only read during orphan cleanup.
function legacyPidFilePath(): string {
  return path.join(config.llmRoot, 'llama-server.pid');
}

export function getLlmRuntimeState(): LlmRuntimeState { return state; }

export function getRunningLlmModelId(): LlmModelId | null { return runningModelId; }

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function touch(): void {
  clearIdleTimer();
  if (!child || state !== 'running') return;
  idleTimer = setTimeout(() => {
    if (inFlight === 0) void stopLlmServer('idle');
    else touch();
  }, config.llmIdleShutdownMs);
  idleTimer.unref();
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('No free port'))));
    });
  });
}

interface Candidate { bin: string; gpuLayers: number }

async function pickCandidates(): Promise<Candidate[]> {
  const platform = process.platform;
  const arch = process.arch;
  if (config.llamaServerPathOverride) {
    const gpuLayers = llmGpuLayers({ variant: null, override: config.llmGpuLayersOverride, customBinary: true });
    const list: Candidate[] = [{ bin: config.llamaServerPathOverride, gpuLayers }];
    if (gpuLayers > 0) list.push({ bin: config.llamaServerPathOverride, gpuLayers: 0 });
    return list;
  }
  const cpu = llmCpuVariantDir({ platform, arch });
  if (!cpu) return [];
  let variant: LlmVariantDir | null = llmVariantDir({ platform, arch, gpuEngine: config.whisperGpuEngine });
  if (variant === 'win-x64-cuda' && !(await llamaBuildInstalled(config.llmRoot, variant))) variant = cpu;
  const primaryVariant = variant ?? cpu;
  const gpuLayers = llmGpuLayers({ variant: primaryVariant, override: config.llmGpuLayersOverride, customBinary: false });
  const list: Candidate[] = [{ bin: llamaServerPath(config.llmRoot, primaryVariant), gpuLayers }];
  if (gpuLayers > 0) list.push({ bin: llamaServerPath(config.llmRoot, cpu), gpuLayers: 0 });
  return list;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/// Spawns one llama-server and waits until /health answers 200. Resolves with the child; rejects (after killing it) otherwise.
async function launch(candidate: Candidate, modelPath: string, modelId: LlmModelId): Promise<{ proc: ChildProcess; port: number }> {
  const port = await findFreePort();
  const bin = await toSafePath(candidate.bin);
  const safeModel = await toSafePath(modelPath);
  const args = buildLlamaServerArgs({ modelPath: safeModel, port, gpuLayers: candidate.gpuLayers, contextSize: LLM_CONTEXT_SIZE, alias: modelId });

  const proc = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  const pushLines = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > LOG_TAIL_LINES) tail.shift();
    }
  };
  proc.stdout?.on('data', pushLines);
  proc.stderr?.on('data', pushLines);

  let exited: string | null = null;
  proc.once('exit', (code, signal) => { exited = `exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`; });
  proc.once('error', (err) => { exited = `could not be started: ${err.message}`; });

  const fail = (reason: string): Error => {
    if (proc.exitCode === null && !proc.killed) proc.kill();
    console.error(`[llm] llama-server failed to start (${reason}; gpuLayers=${candidate.gpuLayers})`);
    for (const line of tail) console.error(`[llm]   ${line}`);
    return new Error(reason);
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw fail(exited);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return { proc, port };
    } catch {
      // not listening yet
    }
    await sleep(READY_POLL_MS);
  }
  throw fail('timed out waiting for the model to load');
}

async function startServer(modelId: LlmModelId, modelPath: string): Promise<{ baseURL: string; modelId: LlmModelId }> {
  state = 'starting';
  try {
    const candidates = await pickCandidates();
    for (const candidate of candidates) {
      let launched: { proc: ChildProcess; port: number };
      try {
        launched = await launch(candidate, modelPath, modelId);
      } catch {
        continue;
      }
      const { proc, port } = launched;
      child = proc;
      runningModelId = modelId;
      runningBaseURL = `http://127.0.0.1:${port}/v1`;
      state = 'running';
      console.log(`[llm] llama-server ready: model=${modelId} port=${port} pid=${proc.pid} gpuLayers=${candidate.gpuLayers}`);
      try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(pidFilePath(), String(proc.pid ?? ''), 'utf-8');
      } catch {
        // pid file is best effort
      }
      proc.once('exit', (code, signal) => {
        console.log(`[llm] llama-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        if (child === proc) {
          child = null;
          state = 'stopped';
          runningModelId = null;
          runningBaseURL = null;
          clearIdleTimer();
          fs.rmSync(pidFilePath(), { force: true });
        }
      });
      // The toggle may have been switched off while the model was loading: never leave a process running then.
      if (!(await readLlmSettings()).enabled) {
        await stopLlmServer('disabled during start');
        throw new LlmUnavailableError('The local language model is turned off.');
      }
      touch();
      return { baseURL: `http://127.0.0.1:${port}/v1`, modelId };
    }
    throw new Error('The local language model could not be started.');
  } catch (err) {
    state = child ? 'running' : 'stopped';
    throw err;
  }
}

export async function ensureLlmServer(): Promise<{ baseURL: string; modelId: LlmModelId }> {
  if (isLlmRelocating()) throw new LlmUnavailableError('The local language model files are being moved.');
  if (!(await llmLocationAvailable())) throw new LlmUnavailableError(LLM_LOCATION_UNAVAILABLE_MESSAGE);
  const settings = await readLlmSettings();
  if (!settings.enabled) throw new LlmUnavailableError('The local language model is turned off.');
  if ((await llmInstallState(settings.model)) !== 'ready') throw new LlmUnavailableError('The local language model is not downloaded yet.');

  if (startPromise) {
    const pending = await startPromise;
    if (pending.modelId === settings.model.id) return pending;
  }
  if (child && state === 'running') {
    if (runningModelId === settings.model.id && runningBaseURL) {
      touch();
      return { baseURL: runningBaseURL, modelId: settings.model.id };
    }
    await stopLlmServer('model changed');
  }

  if (!startPromise) {
    startPromise = startServer(settings.model.id, llmModelPath(config.llmRoot, settings.model))
      .finally(() => { startPromise = null; });
  }
  return startPromise;
}

/// Runs `fn` with a client for the local model, starting llama-server first when needed. The idle timer restarts
/// when the call finishes and never fires while a call is in flight.
export async function withLocalLlm<T>(fn: (client: LlmClient, modelId: LlmModelId) => Promise<T>): Promise<T> {
  inFlight++;
  try {
    const { baseURL, modelId } = await ensureLlmServer();
    const client = createLlmClient({ baseURL, defaultModel: modelId });
    return await fn(client, modelId);
  } finally {
    inFlight--;
    touch();
  }
}

export async function stopLlmServer(reason: string): Promise<void> {
  const proc = child;
  if (!proc) return;
  console.log(`[llm] stopping llama-server (${reason})`);
  clearIdleTimer();
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once('exit', () => resolve());
  });
  proc.kill();
  const killTimer = setTimeout(() => { proc.kill('SIGKILL'); }, 3000);
  await exited;
  clearTimeout(killTimer);
  if (child === proc) {
    child = null;
    state = 'stopped';
    runningModelId = null;
    runningBaseURL = null;
  }
  fs.rmSync(pidFilePath(), { force: true });
}

export function killLlmServerSync(): void {
  try {
    child?.kill();
    fs.rmSync(pidFilePath(), { force: true });
  } catch {
    // best effort on exit
  }
}

/// A previous app run that died hard may have left llama-server behind (it holds GBs of RAM): kill it by pid file,
/// but only after confirming the pid still belongs to a llama-server. Never throws.
export async function cleanupOrphanedLlmServer(): Promise<void> {
  for (const pidFile of [pidFilePath(), legacyPidFilePath()]) {
    try {
      const pidText = fs.readFileSync(pidFile, 'utf-8').trim();
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive && isLlamaServerProcess(pid)) {
          process.kill(pid);
          console.log(`[llm] killed orphaned llama-server pid=${pid}`);
        }
      }
    } catch {
      // no pid file or not readable
    }
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      // ignore
    }
  }
}

function isLlamaServerProcess(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return out.toLowerCase().includes('llama-server.exe');
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
      return out.includes('llama-server');
    }
  } catch {
    // process vanished or tool missing
  }
  return false;
}
