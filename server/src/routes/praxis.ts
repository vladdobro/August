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
import {
  isValidLiveKey,
  readSessionActionItems,
  readLiveActionItems,
  mutateSessionActionItems,
  mutateLiveActionItems,
} from '../services/liveActionItems.js';
import {
  buildSeparateTaskDraft,
  buildCommonTaskDraft,
  stripActionItemsSection,
  type ActionItemsExportContext,
  type TaskDraft,
} from '../services/transcriptActionItems.js';
import type { ActionItem, ActionItemsFile } from '../types.js';

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

// POST /api/praxis/action-items (AUG-166): export action items as separate cards or one checklist card
router.post('/action-items', async (req, res) => {
  const { projectPath, mode, itemIds, sessionId, liveKey, force, transcript: bodyTranscript } = req.body as {
    projectPath?: string; mode?: string; itemIds?: unknown; sessionId?: unknown; liveKey?: unknown; force?: boolean; transcript?: unknown;
  };

  if (!projectPath || typeof projectPath !== 'string') {
    res.status(400).json({ error: 'projectPath is required' });
    return;
  }
  if (mode !== 'separate' && mode !== 'common') {
    res.status(400).json({ error: "mode must be 'separate' or 'common'" });
    return;
  }
  if (!Array.isArray(itemIds) || itemIds.length === 0 || !itemIds.every((i) => typeof i === 'string')) {
    res.status(400).json({ error: 'itemIds must be a non-empty array of strings' });
    return;
  }
  const hasSession = typeof sessionId === 'string' && sessionId !== '';
  const hasLive = liveKey !== undefined && liveKey !== null && liveKey !== '';
  if (hasSession === hasLive) {
    res.status(400).json({ error: 'Provide exactly one of sessionId or liveKey' });
    return;
  }
  if (hasLive && !isValidLiveKey(liveKey)) {
    res.status(400).json({ error: 'Invalid liveKey' });
    return;
  }

  const normalized = path.resolve(projectPath.trim());
  if (!(await validatePraxisProject(normalized))) {
    res.status(400).json({ error: `Not a PraxisOS project: ${normalized}` });
    return;
  }

  try {
    let file: ActionItemsFile | null;
    let ctx: Omit<ActionItemsExportContext, 'prompt'>;
    let duration: string;
    if (hasSession) {
      const sid = sessionId as string;
      const session = await sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      file = await readSessionActionItems(sid);
      ctx = {
        sessionTitle: session.title,
        sessionRef: `${session.title} (session ${session.id})`,
        meetingDate: session.createdAt.slice(0, 10),
        participants: { me: '', them: '' },
        transcript: mode === 'separate' ? stripActionItemsSection((await sessionManager.getTranscript(sid)) ?? '') || null : null,
      };
      duration = formatDurationForPrompt(session.duration);
    } else {
      file = await readLiveActionItems(liveKey as string);
      ctx = {
        sessionTitle: 'Live recording',
        sessionRef: `live recording in progress (key ${liveKey as string})`,
        meetingDate: new Date().toISOString().slice(0, 10),
        participants: { me: '', them: '' },
        transcript: mode === 'separate' && typeof bodyTranscript === 'string' ? bodyTranscript.slice(0, 1_000_000) : null,
      };
      duration = '0s';
    }
    if (!file) {
      res.status(404).json({ error: 'No action items' });
      return;
    }
    ctx.participants = file.participants;

    const ids = itemIds as string[];
    const picked = file.items.filter((i) => ids.includes(i.id));
    if (picked.length === 0) {
      res.status(400).json({ error: 'None of the selected items exist' });
      return;
    }
    const alreadySent = picked.filter((i) => i.praxis).map((i) => ({ id: i.id, taskId: i.praxis!.taskId }));
    if (!force && alreadySent.length > 0) {
      res.status(409).json({ error: 'Some items were already sent to Praxis', alreadySent });
      return;
    }

    const prefs = await readPreferencesMigrated();
    const resolved = resolvePraxisPrompt(prefs, normalized);
    const prompt = applyPromptVariables(resolved.prompt, { sessionName: ctx.sessionTitle, date: ctx.meetingDate, duration });
    const fullCtx: ActionItemsExportContext = { ...ctx, prompt };
    const drafts: TaskDraft[] = mode === 'separate'
      ? picked.map((i) => buildSeparateTaskDraft(i, fullCtx))
      : [buildCommonTaskDraft(picked, fullCtx)];

    const tasks: Array<{ taskId: string; itemIds: string[] }> = [];
    let projectTag: string | null = null;
    for (const d of drafts) {
      const r = await createPraxisTask(normalized, d.title, d.why, d.criteria, { constraints: d.constraints, labels: ['meeting-action-item'] });
      projectTag = r.projectTag;
      tasks.push({ taskId: r.id, itemIds: d.itemIds });
    }

    const sentAt = new Date().toISOString();
    const taskByItem = new Map<string, string>();
    for (const t of tasks) for (const id of t.itemIds) taskByItem.set(id, t.taskId);
    const mutator = (items: ActionItem[]): boolean => {
      let changed = false;
      for (const item of items) {
        const taskId = taskByItem.get(item.id);
        if (!taskId) continue;
        item.praxis = { taskId, projectPath: normalized, sentAt };
        changed = true;
      }
      return changed;
    };
    let resultFile: ActionItemsFile = file;
    try {
      const marked = hasSession
        ? await mutateSessionActionItems(sessionId as string, mutator)
        : await mutateLiveActionItems(liveKey as string, mutator);
      if (marked) resultFile = marked;
    } catch (err) {
      console.warn(`[praxis] action items created but not marked: ${(err as Error).message}`);
    }

    res.status(201).json({ ok: true, tasks, projectTag, promptSource: resolved.source, file: resultFile });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'Failed to create Praxis tasks' });
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
