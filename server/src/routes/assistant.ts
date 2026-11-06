import path from 'node:path';
import { Router, type Request, type Response } from 'express';

import {
  applyCopilotMode,
  applySessionDisable,
  applySessionEnable,
  buildAssistantStatus,
  isClaudeUsable,
  probePraxisReachable,
  type RuleResult,
} from '../services/assistantState.js';
import { getClaudeProbe } from '../services/claudeCli.js';
import { handleMcpPost, mcpMethodNames } from '../services/augustMcp.js';
import { loopbackOnly } from './capture.js';
import { validatePraxisProject } from '../services/praxisIntegration.js';
import { PraxisDownError, praxisMcp } from '../services/praxisMcpClient.js';
import { readPreferences, writePreferences, type PreferencesRecord } from '../services/preferencesStore.js';

/// AI assistants (AUG-198). Only these routes write aiCopilotMode / aiCopilotConsent / aiCopilotAlwaysAck / aiSessionEnabled / aiConsent;
/// DELETE /api/preferences resets them.
const router = Router();

async function status(recheck = false) {
  const [claude, praxis] = await Promise.all([getClaudeProbe(recheck), probePraxisReachable()]);
  return buildAssistantStatus(await readPreferences(), claude, praxis);
}

const fail = (res: Response) => res.status(500).json({ error: 'Something went wrong.' });

router.get('/status', async (req, res) => {
  try {
    res.json(await status(req.query.recheck === '1'));
  } catch {
    fail(res);
  }
});

async function applyRule(
  req: Request,
  res: Response,
  rule: (prefs: PreferencesRecord, body: unknown, usable: boolean) => RuleResult,
) {
  try {
    const claude = await getClaudeProbe();
    const r = rule(await readPreferences(), req.body, isClaudeUsable(claude));
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    await writePreferences(r.prefs);
    res.json(await status());
  } catch {
    fail(res);
  }
}

router.post('/copilot-mode', (req, res) => applyRule(req, res, applyCopilotMode));
router.post('/enable', (req, res) => applyRule(req, res, applySessionEnable));

router.post('/disable', async (_req, res) => {
  try {
    await writePreferences(applySessionDisable(await readPreferences()));
    res.json(await status());
  } catch {
    fail(res);
  }
});

/// AUG-197: TL;DR of one project-context route for the copilot card's "Open route". Loopback only.
const COPILOT_ROUTE_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
router.get('/copilot/route', loopbackOnly, async (req, res) => {
  const projectPath = req.query.projectPath;
  const route = req.query.route;
  if (typeof projectPath !== 'string' || !projectPath || projectPath.length > 1024 || typeof route !== 'string' || !COPILOT_ROUTE_RE.test(route) || route.includes('..')) {
    res.status(400).json({ error: 'projectPath and route are required.' });
    return;
  }
  try {
    const root = path.resolve(projectPath);
    if (!(await validatePraxisProject(root))) {
      res.status(404).json({ error: 'Not a Praxis project.' });
      return;
    }
    const text = await praxisMcp.callTool('read_context_route', { project_root: root, route, mode: 'tldr' }, 3000);
    res.json({ text: text.slice(0, 4000) });
  } catch (err) {
    if (err instanceof PraxisDownError) res.status(503).json({ error: 'PraxisOS is not running.' });
    else fail(res);
  }
});

/// AUG-199: the "august" MCP server of the session child. The token in the path is the credential (per child, dies with it); loopback only. Only method names are logged.
router.post('/mcp/:token', loopbackOnly, (req, res) => {
  const r = handleMcpPost(req.params.token, req.body);
  if (r.status !== 404) console.log(`[assistant] mcp ${mcpMethodNames(req.body)} -> ${r.status}`);
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  if (r.json !== undefined) res.status(r.status).json(r.json);
  else res.status(r.status).end();
});
router.get('/mcp/:token', loopbackOnly, (_req, res) => {
  res.setHeader('Allow', 'POST, DELETE');
  res.status(405).end();
});
router.delete('/mcp/:token', loopbackOnly, (_req, res) => {
  res.status(200).end();
});

export default router;
