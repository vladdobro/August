import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Router } from 'express';

import * as sessionManager from '../services/sessionManager.js';
import { validatePraxisProject, createPraxisTask } from '../services/praxisIntegration.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const router = Router();

const ACCEPTANCE_CRITERIA_TEMPLATE = `Process this meeting transcript following these instructions:

## Pre-processing (before any extraction)
1. Read the full transcript before extracting anything.
2. Reason through: who attended, meeting purpose, which projects/routes are touched.
3. Classify every extractable item as: decision / action item / context insight / blocker.
4. Call search_project_context with domain keywords from the transcript BEFORE any route read or write.
5. Scan active tasks (get_active_tasks) before creating new ones to prevent duplicates.

## Deliverables
1. Summary — structured by topics, saved to project-context/commitments/YYYY-MM-DD-{participants}-summary.md
2. Action items — concrete tasks with owners. Only create a task if: (a) the sender personally committed to do it (assignee = "Me"), AND (b) it has a clear outcome, assignable owner, and defined scope. Vague discussion points go to context updates, not tasks.
3. Commitments — agreements between participants (CMT-NNN, sequential numbering), added to the relevant commit-with-{name}/README.md child route.
4. Route updates — distribute new information to all relevant project-context routes. Always merge into existing records — never replace them.

## Quality rules
- Every task must be self-contained: title (what), business justification (why), and behavioral acceptance criteria that a person who did not attend the meeting can act on alone, without additional context.
- Every extracted item must be anchored to a specific statement in the source transcript. Nothing inferred or invented beyond what was explicitly stated.
- Account for every decision, action item, deadline, and blocker. Nothing may be silently skipped — if an item is deferred, state why.
- CMT IDs are sequential and global — check the highest existing one before assigning new ones.
- Always update the commitments index table with the new meeting.
- When something is ambiguous (unclear ownership, deadline, scope, or conflicting statements) — stop and list it in Open Questions instead of guessing.

## Output format
Recap Summary: 2–3 sentences — who met, what was decided, what moves forward.

Extracted Items:
- Decisions: one bullet per decision with the route it updates
- Action Items: one bullet per task — assignee, scope, deadline if stated
- Context Insights: key insights or business rules captured in routes
- Blockers: with owner if identifiable

Processing Log:
- Context Updates: route path + one-line description of what changed
- Tasks Created: task ID and title
- Deferred or Skipped: item + reason
- Open Questions: ambiguities requiring clarification

Runs through the standard 7-step task lifecycle if it's a kanban task, or directly if pasted ad-hoc.`;

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
  const { sessionId, projectPath } = req.body as { sessionId?: string; projectPath?: string };

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
    const taskTitle = `Process meeting: ${session.title}`;
    const result = await createPraxisTask(
      normalized,
      taskTitle,
      transcript,
      ACCEPTANCE_CRITERIA_TEMPLATE,
    );

    res.status(201).json({
      ok: true,
      taskId: result.id,
      taskPath: result.path,
      projectTag: result.projectTag,
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
