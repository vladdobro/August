import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PreferencesRecord } from './preferencesStore.js';
import { sanitizePraxisProjects } from './preferencesStore.js';

export interface PraxisTaskResult {
  id: string;
  path: string;
  projectTag: string | null;
}

const SUFFIX_LENGTH = 6;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateSuffix(): string {
  let suffix = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += SUFFIX_ALPHABET[crypto.randomInt(SUFFIX_ALPHABET.length)];
  }
  return suffix;
}

function extractNumericId(stem: string): number | null {
  const m = stem.match(/^(?:[A-Z0-9]{1,3}-)?(\d+)(?:-[a-z0-9]+)?$/i);
  return m ? parseInt(m[1], 10) : null;
}

async function scanMaxTaskId(tasksDir: string): Promise<number> {
  let maxId = 0;
  try {
    const statusDirs = await fs.readdir(tasksDir, { withFileTypes: true });
    for (const dir of statusDirs) {
      if (!dir.isDirectory()) continue;
      const files = await fs.readdir(path.join(tasksDir, dir.name));
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const stem = file.slice(0, -5);
        const num = extractNumericId(stem);
        if (num !== null && num > maxId) maxId = num;
      }
    }
  } catch {
    // tasks dir may not exist yet
  }
  return maxId;
}

async function readCounter(counterPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(counterPath, 'utf-8');
    const num = parseInt(raw.trim(), 10);
    return isNaN(num) ? 0 : num;
  } catch {
    return 0;
  }
}

async function readTaskTitleTag(projectRoot: string): Promise<string | null> {
  const configPath = path.join(projectRoot, '.praxis', 'config', 'general.yaml');
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const stripped = line.trim();
      if (stripped.startsWith('taskTitleTag:')) {
        let value = stripped.slice('taskTitleTag:'.length).trim();
        if (!value || value.toLowerCase() === 'null') return null;
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    // config file may not exist
  }
  return null;
}

export async function validatePraxisProject(projectPath: string): Promise<boolean> {
  try {
    const praxisDir = path.join(projectPath, '.praxis');
    const stat = await fs.stat(praxisDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function createPraxisTask(
  projectRoot: string,
  title: string,
  why: string,
  criteria: string,
  opts: { constraints?: string; labels?: string[] } = {},
): Promise<PraxisTaskResult> {
  const configDir = path.join(projectRoot, '.praxis', 'config');
  const tasksDir = path.join(projectRoot, '.praxis', 'tasks');
  const newDir = path.join(tasksDir, 'new');

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(newDir, { recursive: true });

  const counterPath = path.join(configDir, 'task_counter');
  const counterValue = await readCounter(counterPath);
  const filesystemMax = await scanMaxTaskId(tasksDir);
  const nextId = Math.max(counterValue, filesystemMax) + 1;

  await fs.writeFile(counterPath, String(nextId), 'utf-8');

  const rawTag = await readTaskTitleTag(projectRoot);
  const normalizedTag = rawTag
    ? rawTag.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 3) || null
    : null;
  const suffix = generateSuffix();
  const compositeId = normalizedTag
    ? `${normalizedTag}-${nextId}-${suffix}`
    : `${nextId}-${suffix}`;

  const formattedTitle = normalizedTag
    ? `[${normalizedTag}-${nextId}] ${title}`
    : `[${nextId}] ${title}`;

  const now = Date.now();
  const task = {
    id: compositeId,
    assignee: 'assistant.json',
    status: 'new',
    title: formattedTitle,
    why_we_need_this: why,
    acceptance_criteria: criteria,
    important_constraints: opts.constraints ?? '',
    labels: opts.labels ?? ['meeting-transcript'],
    on_hold_reason: '',
    contextRouterIncluded: false,
    created_at: now,
    column_entered_at: now,
  };

  const filePath = path.join(newDir, `${compositeId}.json`);
  const tmpPath = path.join(newDir, `.${compositeId}.json.tmp`);

  await fs.writeFile(tmpPath, JSON.stringify(task, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpPath, filePath);

  return { id: compositeId, path: `.praxis/tasks/new/${compositeId}.json`, projectTag: normalizedTag };
}

export const BUILT_IN_PROMPT = `Process this meeting transcript following these instructions:

## Pre-processing (before any extraction)
1. Read the full transcript before extracting anything.
2. Identify participants: [Me] is the sender. Determine who [Them] is from the transcript context — fill in "Them is: {name/role}".
3. Predict the most appropriate professional roles for each participant based on what they discuss, their domain language, and the decisions they make.
4. Reason through: who attended, meeting purpose, which projects/routes are touched.
5. Classify every extractable item as: decision / action item / context insight / blocker.
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

export const PROMPT_VARIABLES = ['sessionName', 'date', 'duration'] as const;

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/// Project prompt -> default prompt -> built-in. Blank strings count as "not set".
export function resolvePraxisPrompt(
  prefs: PreferencesRecord,
  projectPath: string,
): { prompt: string; source: 'project' | 'default' | 'built-in' } {
  const projects = sanitizePraxisProjects(prefs.praxisProjects);
  const project = projects.find((p) => samePath(p.path, projectPath));
  if (project?.prompt?.trim()) return { prompt: project.prompt, source: 'project' };
  const def = typeof prefs.praxisDefaultPrompt === 'string' ? prefs.praxisDefaultPrompt : '';
  if (def.trim()) return { prompt: def, source: 'default' };
  return { prompt: BUILT_IN_PROMPT, source: 'built-in' };
}

export interface PromptVariables {
  sessionName: string;
  date: string;
  duration: string;
}

/// Replaces {sessionName}, {date}, {duration}; unknown {tokens} are left untouched.
export function applyPromptVariables(prompt: string, vars: PromptVariables): string {
  return prompt.replace(/\{(sessionName|date|duration)\}/g, (_m, key: keyof PromptVariables) => vars[key]);
}

export function formatDurationForPrompt(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
