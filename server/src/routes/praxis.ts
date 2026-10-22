import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Router } from 'express';

import * as sessionManager from '../services/sessionManager.js';
import {
  validatePraxisProject,
  createPraxisTask,
  BUILT_IN_PROMPT,
  PROMPT_VARIABLES,
  resolvePraxisPrompt,
  applyPromptVariables,
  formatDurationForPrompt,
} from '../services/praxisIntegration.js';
import { readPreferencesMigrated } from '../services/preferencesStore.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const router = Router();


// GET /api/praxis/default-prompt
router.get('/default-prompt', (_req, res) => {
  res.json({ prompt: BUILT_IN_PROMPT, variables: PROMPT_VARIABLES });
});

// POST /api/praxis/validate
router.post('/validate', async (req, res) => {
  const { projectPath } = req.body as { projectPath?: string };
  if (!projectPath || typeof projectPath !== 'string') {
    res.status(400).json({ error: 'projectPath is required' });
    return;
  }

  const normalized = path.resolve(projectPath.trim());
  const valid = await validatePraxisProject(normalized);
  res.json({ valid, projectPath: normalized });
});

// POST /api/praxis/send
router.post('/send', async (req, res) => {
  const { sessionId, projectPath, taskName } = req.body as { sessionId?: string; projectPath?: string; taskName?: string };

  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }
  if (!projectPath || typeof projectPath !== 'string') {
    res.status(400).json({ error: 'projectPath is required' });
    return;
  }

  const normalized = path.resolve(projectPath.trim());
  const valid = await validatePraxisProject(normalized);
  if (!valid) {
    res.status(400).json({ error: `Not a PraxisOS project: ${normalized}` });
    return;
  }

  const session = await sessionManager.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const transcript = await sessionManager.getTranscript(sessionId);
  if (!transcript) {
    res.status(400).json({ error: 'Transcript not available for this session' });
    return;
  }

  try {
    const taskTitle = taskName?.trim() || `Process meeting: ${session.title}`;
    const prefs = await readPreferencesMigrated();
    const resolved = resolvePraxisPrompt(prefs, normalized);
    const criteria = applyPromptVariables(resolved.prompt, {
      sessionName: taskTitle,
      date: new Date().toISOString().slice(0, 10),
      duration: formatDurationForPrompt(session.duration),
    });
    const result = await createPraxisTask(normalized, taskTitle, transcript, criteria);

    res.status(201).json({
      ok: true,
      taskId: result.id,
      taskPath: result.path,
      projectTag: result.projectTag,
      promptSource: resolved.source,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'Failed to create Praxis task' });
  }
});

// POST /api/praxis/browse — open native OS folder picker dialog
router.post('/browse', async (_req, res) => {
  try {
    let selectedPath = '';

    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '[System.Windows.Forms.Application]::EnableVisualStyles()',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.ShowInTaskbar = $false',
        '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
        '$owner.Show()',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Select Praxis project folder'",
        '$result = $d.ShowDialog($owner)',
        '$owner.Close()',
        '$owner.Dispose()',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
      ].join('; ');
      const { stdout } = await execFileAsync('powershell.exe', ['-STA', '-NoProfile', '-Command', ps], { timeout: 120_000 });
      selectedPath = stdout.trim();
    } else if (process.platform === 'darwin') {
      const { stdout } = await execAsync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select Praxis project folder")'`,
        { timeout: 120_000 },
      );
      selectedPath = stdout.trim();
    } else {
      const { stdout } = await execAsync(
        `zenity --file-selection --directory --title="Select Praxis project folder" 2>/dev/null`,
        { timeout: 120_000 },
      );
      selectedPath = stdout.trim();
    }

    res.json({ path: selectedPath || null });
  } catch {
    res.json({ path: null });
  }
});

export default router;
