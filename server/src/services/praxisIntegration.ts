import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

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

const ASSIGNEE_PRIORITY = ['recap-master.json', 'cartographer.json'];

async function resolveAssignee(projectRoot: string): Promise<string | null> {
  const assigneesDir = path.join(projectRoot, '.praxis', 'assignees');
  for (const candidate of ASSIGNEE_PRIORITY) {
    try {
      await fs.access(path.join(assigneesDir, candidate));
      return candidate;
    } catch {
      // candidate not found, try next
    }
  }
  return null;
}

export async function createPraxisTask(
  projectRoot: string,
  title: string,
  why: string,
  criteria: string,
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

  const assignee = await resolveAssignee(projectRoot);
  const now = Date.now();
  const task = {
    id: compositeId,
    assignee,
    status: 'new',
    title: formattedTitle,
    why_we_need_this: why,
    acceptance_criteria: criteria,
    important_constraints: '',
    labels: ['meeting-transcript'],
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
