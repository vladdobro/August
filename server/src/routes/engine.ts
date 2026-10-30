import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';

import { config, WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD, whisperBinName, whisperPlatformDir, WHISPER_VAD_MODEL } from '../config.js';
import { cudaBuildComplete, ensureWhisperCuda, getCudaStatus, onCudaStatus } from '../services/cudaDownloader.js';
import { ensureLlmInstalled } from '../services/llmInstaller.js';
import { stopLlmServer } from '../services/llmServer.js';
import { gpuState, resolveGpuPolicy } from '../services/gpuBackend.js';
import { detectNvidiaGpu } from '../services/nvidiaDetect.js';
import { PREFS_PATH } from '../services/preferencesStore.js';
import { probeGpuBackend } from '../services/whisper.js';

// In packaged builds process.resourcesPath points to the Electron resources
// folder where extraResources places whisper binaries. WHISPER_BIN_ROOT resolves
// from the server source tree which lands inside resources/app/ — a different
// directory that does NOT contain extraResources files. Use resourcesPath when
// available so paths work in both packaged and dev builds.
function resolveCpuBinDir(): string {
  const platDir = whisperPlatformDir() ?? `${process.platform}-${process.arch}`;
  const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (rp) return path.join(rp, 'whisper', 'bin', platDir);
  return path.join(WHISPER_BIN_ROOT, platDir);
}

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

  // Rebuild the process GPU state BEFORE probing: probeGpuBackend() reads the policy synchronously, and reset()
  // bumps the epoch so jobs spawned under the old engine cannot confirm or flip the new state (AUG-140).
  gpuState.reset(resolveGpuPolicy({
    platform: process.platform,
    arch: process.arch,
    override: config.whisperGpuOverride,
    gpuEngine: config.whisperGpuEngine,
  }));

  // AUG-162: the local language model picks its build from the engine; the next request restarts it on the right one.
  void stopLlmServer('gpu engine changed');

  if (engine === 'cuda') {
    // Reuse the CUDA path resolved at startup (Electron sets WHISPER_CUDA_BIN_PATH
    // to the AppData download location). Only fall back to WHISPER_BIN_ROOT for dev.
    if (!config.whisperCudaBinPath) {
      config.whisperCudaBinPath = path.join(WHISPER_BIN_ROOT, WHISPER_CUDA_BUILD.extractedDir, whisperBinName());
    }

    // Always go through ensureWhisperCuda(): it activates a complete build immediately, and re-downloads when the
    // folder is missing or incomplete (interrupted download), so a retry from the UI needs no restart (AUG-140).
    const complete = await cudaBuildComplete(path.dirname(config.whisperCudaBinPath));
    void ensureWhisperCuda().then(() => probeGpuBackend()).then(() => ensureLlmInstalled());
    res.json({ ok: true, engine: config.whisperGpuEngine, cudaStatus: complete ? 'present' : 'downloading' });
    return;
  } else {
    // Switch back to CPU — use the correct resources path for packaged builds. config.whisperCudaBinPath is where
    // the CUDA build lives (Electron: %APPDATA%); it is engine-independent and must survive a CPU switch, or the
    // next cuda switch falls back to WHISPER_BIN_ROOT inside resources/app and downloads there (AUG-140).
    const dir = resolveCpuBinDir();
    config.whisperBinPath = path.join(dir, whisperBinName());
    config.whisperVadModelPath = path.join(dir, WHISPER_VAD_MODEL.fileName);
  }

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
