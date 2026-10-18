import path from 'node:path';

import { config } from '../config.js';

/// Backend reported by /api/health and the startup log (AUG-116).
export type GpuBackend = 'vulkan' | 'metal' | 'cuda' | 'cpu' | 'unknown';

export interface GpuPolicy {
  /// Backend the platform's whisper-cli build uses when the GPU is enabled; null = CPU-only platform.
  nativeBackend: 'vulkan' | 'metal' | 'cuda' | null;
  /// Initial mode: true = spawn without --no-gpu.
  useGpu: boolean;
  /// true when WHISPER_USE_GPU pinned the mode — no startup probe, no runtime fallback.
  locked: boolean;
}

export function resolveGpuPolicy(input: { platform: string; arch: string; override: boolean | null; gpuEngine?: string }): GpuPolicy {
  const nativeBackend: GpuPolicy['nativeBackend'] =
    input.platform === 'darwin' && input.arch === 'arm64' ? 'metal'
    : input.platform === 'win32' && input.arch === 'x64' && input.gpuEngine === 'cuda' ? 'cuda'
    : null;
  if (input.override !== null) return { nativeBackend, useGpu: input.override, locked: true };
  return { nativeBackend, useGpu: nativeBackend !== null, locked: false };
}

/// What execFile hands back when whisper-cli fails. `code` is the numeric exit code, an errno string such as
/// 'ENOENT', or null/undefined when the child died from a signal (cancellation, execFile timeout).
export interface WhisperExit {
  code: number | string | null | undefined;
  signal?: string | null;
  killed?: boolean;
  stderr: string;
}

export type WhisperFailureClass = 'gpu' | 'other';

export const STATUS_DLL_NOT_FOUND = 0xc0000135;

/// NTSTATUS codes meaning the process image could not even be loaded. With the v1.8.4 Vulkan build that is a missing
/// vulkan-1.dll: ggml-vulkan.dll is a static import of ggml.dll, so the crash happens before main(). Since AUG-117
/// `npm run setup` bundles the loader next to whisper-cli, so on a complete install this code is unreachable; seeing it
/// means whisper/bin/win-x64 is incomplete (re-run setup / reinstall). Still classified 'gpu' so the retry engine and the
/// probe treat it uniformly.
const PROCESS_LOAD_FAILURE_CODES = new Set<number>([STATUS_DLL_NOT_FOUND]);

/// Error phrasing ggml-vulkan / the Vulkan loader emit on stderr when the backend cannot be brought up.
/// Deliberately does NOT match the "ggml_vulkan: Found 1 Vulkan devices" banner a healthy run prints even under
/// --no-prints, so an unrelated failure on a working GPU machine is never re-run on the CPU.
const GPU_STDERR_PATTERNS: RegExp[] = [
  /vulkan-1\.dll/i,
  /ggml_cuda_init.*(?:error|fail)/i,
  /CUDA error/i,
  /cudaError\w*/i,
  /failed to initiali[sz]e.*cuda/i,
  /ggml_vulkan:\s*(error|failed|no devices? found|found 0 vulkan devices)/i,
  /ggml_backend_vk\w*:.*\b(error|fail)/i,
  /\bvk::\w*(Error|Exception)\b/,
  /\bVK_ERROR_[A-Z_]+/,
  /failed to initiali[sz]e (the )?(vulkan|gpu|ggml[- ]vulkan)/i,
  /vulkan (error|initiali[sz]ation failed)/i,
];

/// Banner ggml-vulkan prints on stderr when the loader finds devices: "ggml_vulkan: Found 1 Vulkan devices:". It is
/// printed even under --no-prints and for `--help`. When the bundled loader finds no driver (no/old GPU driver) the
/// banner is absent, whisper-cli silently runs on CPU and exits 0 — verified with VK_LOADER_DRIVERS_DISABLE=*. That is
/// how the server learns it is on CPU without any failure (AUG-117).
const VULKAN_DEVICE_BANNER = /ggml_vulkan:\s*Found\s+(\d+)\s+Vulkan devices?/i;

/// Number of Vulkan devices ggml-vulkan reported on stderr, or null when the banner is absent (no loader-visible device).
export function countVulkanDevices(stderr: string): number | null {
  const match = VULKAN_DEVICE_BANNER.exec(stderr ?? '');
  return match ? Number(match[1]) : null;
}

/// Reason recorded on GpuState when whisper-cli started fine but the loader saw no Vulkan device (log-only text).
export const NO_VULKAN_DEVICE_REASON = 'no Vulkan device found; whisper-cli runs on CPU';

/// Banner ggml-cuda prints on stderr: "ggml_cuda_init: found 1 CUDA devices:". Absent when no NVIDIA GPU/driver (AUG-130).
const CUDA_DEVICE_BANNER = /ggml_cuda_init:\s*found\s+(\d+)\s+CUDA devices?/i;

export function countCudaDevices(stderr: string): number | null {
  const match = CUDA_DEVICE_BANNER.exec(stderr ?? '');
  return match ? Number(match[1]) : null;
}

export const NO_CUDA_DEVICE_REASON = 'no CUDA device found; whisper-cli runs on CPU';

/// Node reports NTSTATUS exit codes as uint32 (3221225781); other layers show them signed (-1073741515).
export function normalizeExitCode(code: number | string | null | undefined): number | null {
  if (typeof code !== 'number' || !Number.isFinite(code)) return null;
  return code < 0 ? code + 0x1_0000_0000 : code;
}

export function formatExitCode(code: number | string | null | undefined): string {
  const n = normalizeExitCode(code);
  if (n === null) return String(code ?? 'signal');
  return n >= 0xc000_0000 ? `0x${n.toString(16).toUpperCase().padStart(8, '0')}` : String(n);
}

export function isProcessLoadFailure(exit: WhisperExit): boolean {
  const code = normalizeExitCode(exit.code);
  return code !== null && PROCESS_LOAD_FAILURE_CODES.has(code);
}

/// Conservative classifier: only failures that are unmistakably the Vulkan backend/runtime count as 'gpu'.
/// Cancellations and timeouts (signal/killed), a missing binary (errno string) and every other exit stay 'other'.
export function classifyWhisperFailure(exit: WhisperExit): WhisperFailureClass {
  if (exit.killed || exit.signal) return 'other';
  if (typeof exit.code === 'string') return 'other';
  if (isProcessLoadFailure(exit)) return 'gpu';
  const stderr = exit.stderr ?? '';
  return GPU_STDERR_PATTERNS.some((re) => re.test(stderr)) ? 'gpu' : 'other';
}

/// One-line, log-only description: exit code plus the first stderr line that explains it.
export function describeExit(exit: WhisperExit): string {
  const lines = (exit.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hint = lines.find((l) => GPU_STDERR_PATTERNS.some((re) => re.test(l))) ?? lines[lines.length - 1];
  const suffix = hint ? `: ${hint.slice(0, 200)}` : '';
  if (exit.signal || exit.killed) return `killed (${exit.signal ?? 'signal'})${suffix}`;
  return `exit ${formatExitCode(exit.code)}${suffix}`;
}

/// Process-wide GPU mode. Starts from the policy, and once a Vulkan failure is classified it stays on CPU for
/// the lifetime of the process, so live chunks and later batch jobs never retry per call.
export class GpuState {
  public policy: GpuPolicy;
  private gpuEnabled = false;
  private confirmed = false;
  private reason: string | null = null;
  private generation = 0;

  constructor(policy: GpuPolicy) {
    this.policy = policy;
    this.apply(policy);
  }

  private apply(policy: GpuPolicy): void {
    this.policy = policy;
    this.gpuEnabled = policy.useGpu;
    this.reason = null;
    // Metal has no post-start failure, CPU-only has no GPU, and a pinned mode is the user's call: all count as resolved.
    // Only vulkan and cuda need probing.
    this.confirmed = policy.locked || (policy.nativeBackend !== 'vulkan' && policy.nativeBackend !== 'cuda');
  }

  /// Rebuild for a new engine (POST /api/engine/switch, AUG-136). Bumps the epoch so jobs spawned under the previous policy can no longer confirm or flip this state (AUG-140).
  reset(policy: GpuPolicy): void {
    this.apply(policy);
    this.generation += 1;
  }

  /// Changes on every reset(); runWhisper() captures it at spawn time.
  epoch(): number {
    return this.generation;
  }

  useGpu(): boolean {
    return this.gpuEnabled;
  }

  /// 'unknown' only while an unpinned Vulkan build has not yet proven it can start (see probeGpuBackend()).
  backend(): GpuBackend {
    if (!this.gpuEnabled) return 'cpu';
    if (this.policy.nativeBackend === null) return 'cpu';
    if (this.policy.nativeBackend === 'vulkan' && !this.confirmed) return 'unknown';
    if (this.policy.nativeBackend === 'cuda' && !this.confirmed) return 'unknown';
    return this.policy.nativeBackend;
  }

  /// True while a job may still switch this process to CPU: GPU on, not pinned, and a Vulkan build.
  canFallBack(): boolean {
    return this.gpuEnabled && !this.policy.locked && (this.policy.nativeBackend === 'vulkan' || this.policy.nativeBackend === 'cuda');
  }

  markGpuConfirmed(): void {
    if (this.gpuEnabled) this.confirmed = true;
  }

  /// Flip to CPU for the rest of the process. Idempotent; returns true on the first flip.
  markGpuUnusable(reason: string): boolean {
    if (!this.gpuEnabled) return false;
    this.gpuEnabled = false;
    this.reason = reason;
    return true;
  }

  fallbackReason(): string | null {
    return this.reason;
  }

  /// Startup-log description of the policy.
  describePolicy(): string {
    const { nativeBackend, useGpu, locked } = this.policy;
    if (locked) return useGpu ? `forced on via WHISPER_USE_GPU=1 (${nativeBackend ?? 'no native backend'})` : 'forced off via WHISPER_USE_GPU=0';
    if (nativeBackend === 'vulkan') return 'vulkan, automatic CPU fallback';
    if (nativeBackend === 'cuda') return 'cuda (NVIDIA), automatic CPU fallback';
    if (nativeBackend === 'metal') return 'metal';
    return 'off (CPU-only build)';
  }
}

/// CUDA twin of ranOnCpuWithoutVulkanDevice (AUG-130).
export function ranOnCpuWithoutCudaDevice(state: GpuState, stderr: string): boolean {
  return state.useGpu() && state.policy.nativeBackend === 'cuda' && !countCudaDevices(stderr);
}

/// True when a successful GPU-mode run without the ggml-vulkan device banner means whisper-cli silently ran on CPU
/// (AUG-117). Only a Vulkan build prints that banner — a Metal or CPU-only run never does, so it must never flip the
/// state (AUG-125: every Metal job after the first used to run with --no-gpu).
export function ranOnCpuWithoutVulkanDevice(state: GpuState, stderr: string): boolean {
  return state.useGpu() && state.policy.nativeBackend === 'vulkan' && !countVulkanDevices(stderr);
}

/// True when `binPath` is the binary the policy's native GPU backend lives in. Under a cuda policy the server may
/// still be spawning the CPU build (CUDA variant downloading, or a job spawned before the engine switch); such a run
/// prints no ggml_cuda_init banner and proves nothing about the GPU, so it must neither confirm nor flip the state (AUG-140).
export function isNativeGpuBinary(state: GpuState, binPath: string, cudaBinPath: string | null = config.whisperCudaBinPath): boolean {
  if (state.policy.nativeBackend !== 'cuda') return true;
  if (!cudaBinPath) return true;
  return path.resolve(binPath) === path.resolve(cudaBinPath);
}

export interface GpuFallbackOptions {
  /// Extracts the whisper-cli exit info from a thrown error; null = not a whisper-cli exit (never retried).
  exitOf: (err: unknown) => WhisperExit | null;
  log: (message: string) => void;
  /// Short job label for the log line.
  label: string;
  /// Whether this run may change the process GPU state (default: always). runWhisper passes false for runs that used the CPU build under a cuda policy or that outlived a gpuState.reset() (AUG-140).
  outcomeApplies?: () => boolean;
}

/// Runs `attempt(useGpu)` with the current mode. When the GPU attempt fails with a GPU-class error and the
/// state still allows a fallback, flips the process to CPU and re-runs the same job once with useGpu=false.
/// Everything else (non-GPU errors, CPU attempts, pinned or Metal modes) is thrown through untouched.
export async function runWithGpuFallback<T>(
  state: GpuState,
  attempt: (useGpu: boolean) => Promise<T>,
  opts: GpuFallbackOptions,
): Promise<T> {
  const useGpu = state.useGpu();
  const applies = () => opts.outcomeApplies?.() ?? true;
  try {
    const result = await attempt(useGpu);
    if (useGpu && applies()) state.markGpuConfirmed();
    return result;
  } catch (err) {
    if (!useGpu || !state.canFallBack() || !applies()) throw err;
    const exit = opts.exitOf(err);
    if (!exit || classifyWhisperFailure(exit) !== 'gpu') throw err;
    const reason = describeExit(exit);
    state.markGpuUnusable(reason);
    opts.log(`GPU backend unusable (${reason}); retrying ${opts.label} once with --no-gpu and staying on CPU for this server run`);
    return attempt(false);
  }
}

/// Process singleton used by runWhisper(), the startup probe and /api/health.
export const gpuState = new GpuState(
  resolveGpuPolicy({ platform: process.platform, arch: process.arch, override: config.whisperGpuOverride, gpuEngine: config.whisperGpuEngine }),
);
