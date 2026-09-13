import path from 'node:path';
import { Router } from 'express';

import * as sessionManager from '../services/sessionManager.js';
import { validatePraxisProject, createPraxisTask } from '../services/praxisIntegration.js';

const router = Router();

const ACCEPTANCE_CRITERIA_TEMPLATE = `Four deliverables from this meeting transcript:

1. Summary — structured by topics, saved to project-context/commitments/YYYY-MM-DD-{participants}-summary.md
2. Action items — concrete tasks with owners, appended to commitments/action-items/README.md
3. Commitments — agreements between participants (CMT-NNN, sequential numbering), added to the relevant commit-with-{name}/README.md child route
4. Route updates — distribute new information to all relevant project-context routes (subordinates, superiors, operations, strategy, etc.)

Key rules:
- CMT IDs are sequential and global — check the highest existing one before assigning new ones
- Always update the commitments index table with the new meeting
- The whole thing runs through the standard 7-step task lifecycle if it's a kanban task, or directly if you paste it ad-hoc`;

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

export default router;
