import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';

import { config, WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD, whisperBinName, whisperPlatformDir, WHISPER_VAD_MODEL } from '../config.js';
import { ensureWhisperCuda, getCudaStatus, onCudaStatus } from '../services/cudaDownloader.js';
import { gpuState, GpuState, resolveGpuPolicy } from '../services/gpuBackend.js';
import { detectNvidiaGpu } from '../services/nvidiaDetect.js';
import { PREFS_PATH } from '../services/preferencesStore.js';
import { fileExists } from '../services/whisper.js';

const router = Router();

async function readPrefs(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(PREFS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writePrefs(prefs: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(PREFS_PATH), { recursive: true });
  await fs.writeFile(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf-8');
}

router.post('/engine/switch', async (req, res) => {
  const { engine } = req.body ?? {};
  if (engine !== 'cpu' && engine !== 'cuda') {
    res.status(400).json({ error: 'engine must be "cpu" or "cuda"' });
    return;
  }

  if (engine === 'cuda') {
    const gpu = detectNvidiaGpu();
    if (!gpu.detected) {
      res.status(400).json({ error: 'No NVIDIA GPU detected' });
      return;
    }
  }

  // Env override wins — refuse to change if explicitly set
  if (process.env.WHISPER_GPU_ENGINE?.trim()) {
    res.status(409).json({ error: 'Engine is locked by WHISPER_GPU_ENGINE environment variable' });
    return;
  }

  // Persist to preferences
  const prefs = await readPrefs();
  prefs.gpuEngine = engine;
  await writePrefs(prefs);

  // Update runtime config
  config.whisperGpuEngine = engine;

  if (engine === 'cuda') {
    const cudaBinPath = path.join(WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD.extractedDir, whisperBinName());
    config.whisperCudaBinPath = cudaBinPath;

    if (await fileExists(cudaBinPath)) {
      config.whisperBinPath = cudaBinPath;
      config.whisperVadModelPath = path.join(path.dirname(cudaBinPath), WHISPER_VAD_MODEL.fileName);
    } else {
      // Start CUDA download in background
      void ensureWhisperCuda();
    }
  } else {
    // Switch back to CPU
    const platDir = whisperPlatformDir() ?? `${process.platform}-${process.arch}`;
    config.whisperBinPath = path.join(WHISPER_BIN_ROOT, platDir, whisperBinName());
    config.whisperCudaBinPath = null;
    config.whisperVadModelPath = path.join(WHISPER_BIN_ROOT, platDir, WHISPER_VAD_MODEL.fileName);
  }

  // Rebuild gpuState with the new engine
  const newPolicy = resolveGpuPolicy({
    platform: process.platform,
    arch: process.arch,
    override: config.whisperGpuOverride,
    gpuEngine: config.whisperGpuEngine,
  });
  // Mutate the singleton — GpuState is process-wide
  Object.assign(gpuState, new GpuState(newPolicy));

  res.json({
    ok: true,
    engine: config.whisperGpuEngine,
    cudaStatus: getCudaStatus().state,
  });
});

router.get('/engine/cuda-progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send current status immediately
  send(getCudaStatus());

  const unsub = onCudaStatus((s) => {
    send(s);
    if (s.state === 'present' || (s.state === 'missing' && s.error)) {
      unsub();
      res.end();
    }
  });

  req.on('close', () => {
    unsub();
  });
});

export default router;
