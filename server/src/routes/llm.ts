import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { Router } from 'express';

import { config, findLlmModel, LLM_MODELS, llmCpuVariantDir } from '../config.js';
import {
  ensureLlmInstalled,
  getLlmDownloadStatus,
  llmInstallState,
  onLlmDownloadStatus,
  readLlmSettings,
} from '../services/llmInstaller.js';
import {
  getLlmLocationStatus,
  isLlmRelocating,
  LLM_LOCATION_UNAVAILABLE_MESSAGE,
  llmLocationAvailable,
  relocateLlmRoot,
  targetRootFor,
  validateRelocation,
} from '../services/llmLocation.js';
import { getLlmRuntimeState, getRunningLlmModelId, LlmUnavailableError, stopLlmServer, withLocalLlm } from '../services/llmServer.js';
import { readPreferences, writePreferences } from '../services/preferencesStore.js';

/// Opt-in local language model (AUG-162). Only these routes write llmEnabled / llmModel to preferences.
const router = Router();
const execFileAsync = promisify(execFile);

/// Answers 409 and returns true when the model folder is missing or the files are being moved (no download / start then).
async function refuseWhileLocationBusy(res: import('express').Response): Promise<boolean> {
  if (isLlmRelocating()) {
    res.status(409).json({ error: 'The local language model files are being moved.' });
    return true;
  }
  if (!(await llmLocationAvailable())) {
    res.status(409).json({ error: LLM_LOCATION_UNAVAILABLE_MESSAGE });
    return true;
  }
  return false;
}

async function buildStatus() {
  const { enabled, model } = await readLlmSettings();
  return {
    enabled,
    modelId: model.id,
    supported: !!llmCpuVariantDir({ platform: process.platform, arch: process.arch }) || !!config.llamaServerPathOverride,
    install: await llmInstallState(model),
    runtime: getLlmRuntimeState(),
    download: getLlmDownloadStatus(),
    location: await getLlmLocationStatus(),
  };
}

router.get('/models', (_req, res) => {
  res.json(LLM_MODELS.map(({ id, label, quality, sizeBytes, ramBytes }) => ({
    id, label, quality, diskBytes: sizeBytes, ramBytes,
  })));
});

router.get('/status', async (_req, res) => {
  res.json(await buildStatus());
});

router.post('/enable', async (req, res) => {
  const model = findLlmModel(req.body?.modelId);
  if (!model) {
    res.status(400).json({ error: 'Unknown model' });
    return;
  }
  if (await refuseWhileLocationBusy(res)) return;
  const prefs = await readPreferences();
  await writePreferences({ ...prefs, llmEnabled: true, llmModel: model.id });
  const running = getRunningLlmModelId();
  if (running && running !== model.id) await stopLlmServer('model changed');
  void ensureLlmInstalled();
  res.json(await buildStatus());
});

router.post('/disable', async (_req, res) => {
  const prefs = await readPreferences();
  await writePreferences({ ...prefs, llmEnabled: false });
  await stopLlmServer('disabled');
  res.json(await buildStatus());
});

router.post('/download', async (_req, res) => {
  const { enabled } = await readLlmSettings();
  if (!enabled) {
    res.status(409).json({ error: 'The local language model is turned off.' });
    return;
  }
  if (await refuseWhileLocationBusy(res)) return;
  void ensureLlmInstalled();
  res.json(await buildStatus());
});

// POST /api/llm/browse-folder — native OS folder picker for the model folder
router.post('/browse-folder', async (_req, res) => {
  try {
    let selectedPath = '';
    if (process.platform === 'win32') {
      const ps = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '[System.Windows.Forms.Application]::EnableVisualStyles()',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.ShowInTaskbar = $false',
        '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
        '$owner.Show()',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Select a folder for the local language model'",
        '$result = $d.ShowDialog($owner)',
        '$owner.Close()',
        '$owner.Dispose()',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
      ].join('; ');
      const { stdout } = await execFileAsync('powershell.exe', ['-STA', '-NoProfile', '-Command', ps], { timeout: 120_000, encoding: 'utf8' });
      selectedPath = stdout.trim();
    } else if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Select a folder for the local language model")'],
        { timeout: 120_000, encoding: 'utf8' },
      );
      selectedPath = stdout.trim();
    } else {
      const { stdout } = await execFileAsync(
        'zenity',
        ['--file-selection', '--directory', '--title=Select a folder for the local language model'],
        { timeout: 120_000, encoding: 'utf8' },
      );
      selectedPath = stdout.trim();
    }
    res.json({ path: selectedPath || null });
  } catch {
    res.json({ path: null });
  }
});

// POST /api/llm/location { path: string | null } — move the model files to <path>/August LLM (null = back to the default).
router.post('/location', async (req, res) => {
  if (config.llmRootPinned) {
    res.status(409).json({ error: 'The model folder is set by system configuration.' });
    return;
  }
  const picked: unknown = req.body?.path;
  if (picked !== null && (typeof picked !== 'string' || !path.isAbsolute(picked))) {
    res.status(400).json({ error: 'Choose a full folder path.' });
    return;
  }
  const target = targetRootFor(picked, config.dataDir);
  if (path.resolve(target) === path.resolve(config.llmRoot)) {
    res.json(await buildStatus());
    return;
  }
  const invalid = validateRelocation(config.llmRoot, target);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  if (isLlmRelocating()) {
    res.status(409).json({ error: 'The model files are already being moved.' });
    return;
  }
  if (getLlmDownloadStatus().downloading) {
    res.status(409).json({ error: 'Wait for the download to finish, then change the folder.' });
    return;
  }
  await stopLlmServer('model folder changed');
  void relocateLlmRoot(target)
    .then(() => ensureLlmInstalled())
    .catch((err) => console.error('[llm] relocation failed:', err));
  res.json(await buildStatus());
});

router.get('/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const current = getLlmDownloadStatus();
  send(current);
  if (!current.downloading) {
    res.end();
    return;
  }

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);

  const unsub = onLlmDownloadStatus((s) => {
    send(s);
    if (!s.downloading) {
      clearInterval(heartbeat);
      unsub();
      res.end();
    }
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
});

router.post('/test', async (_req, res) => {
  const startedAt = Date.now();
  try {
    const result = await withLocalLlm((client) => client.chat({
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Answer in one short sentence.' },
        { role: 'user', content: 'Say that the local language model in August is ready.' },
      ],
      maxTokens: 48,
      temperature: 0,
    }));
    res.json({ ok: true, reply: result.content.trim(), latencyMs: result.latencyMs, totalMs: Date.now() - startedAt });
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error('[llm] test request failed:', err);
    res.status(500).json({ error: 'The local language model did not respond.' });
  }
});

export default router;
