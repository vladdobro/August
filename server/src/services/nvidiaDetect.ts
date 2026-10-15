import { spawnSync } from 'node:child_process';

export interface NvidiaGpuInfo {
  detected: boolean;
  gpuName: string | null;
}

let cached: NvidiaGpuInfo | null = null;

export function detectNvidiaGpu(): NvidiaGpuInfo {
  if (cached) return cached;
  if (process.platform !== 'win32') {
    cached = { detected: false, gpuName: null };
    return cached;
  }
  try {
    const result = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      timeout: 5000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout?.trim()) {
      const name = result.stdout.trim().split('\n')[0].trim();
      cached = { detected: true, gpuName: name };
    } else {
      cached = { detected: false, gpuName: null };
    }
  } catch {
    cached = { detected: false, gpuName: null };
  }
  return cached;
}
