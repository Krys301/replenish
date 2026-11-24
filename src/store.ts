import { PATHS } from './config.ts';
import { readJson, slugify, writeJson } from './fsutil.ts';

export type ProjectStatus = 'queued' | 'in_progress' | 'done' | 'blocked' | 'failed';

export interface Project {
  id: string;
  name: string;
  brief: string;
  priority: number;
  status: ProjectStatus;
  /** Existing git repo to work in (on a replenish/<id> worktree branch). Unset = fresh folder. */
  repo?: string;
  /** Where the work happens; set on first run. */
  workDir?: string;
  /** Claude Code session to resume when a run was cut short. */
  sessionId?: string;
  runs: RunRecord[];
  createdAt: string;
}

export interface RunRecord {
  startedAt: string;
  endedAt: string;
  outcome: 'done' | 'paused' | 'blocked' | 'failed';
  reason: string;
  weeklyBefore?: number;
  weeklyAfter?: number;
  costUsd?: number;
  report?: string;
}

interface QueueFile {
  projects: Project[];
}

export function loadQueue(): Project[] {
  return readJson<QueueFile>(PATHS.queue, { projects: [] }).projects;
}

export function saveQueue(projects: Project[]): void {
  writeJson(PATHS.queue, { projects });
}

export function addProject(input: { name?: string; brief: string; priority?: number; repo?: string }): Project {
  const projects = loadQueue();
  const name = input.name?.trim() || input.brief.split(/[.\n]/)[0]!.trim().slice(0, 60);
  let id = slugify(name);
  for (let n = 2; projects.some((p) => p.id === id); n++) id = `${slugify(name)}-${n}`;
  const project: Project = {
    id,
    name,
    brief: input.brief.trim(),
    priority: input.priority ?? 3,
    status: 'queued',
    repo: input.repo,
    runs: [],
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  saveQueue(projects);
  return project;
}

export function updateProject(id: string, patch: Partial<Project>): Project {
  const projects = loadQueue();
  const i = projects.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`No project "${id}"`);
  projects[i] = { ...projects[i]!, ...patch };
  saveQueue(projects);
  return projects[i]!;
}

export function removeProject(id: string): boolean {
  const projects = loadQueue();
  const next = projects.filter((p) => p.id !== id);
  saveQueue(next);
  return next.length !== projects.length;
}

/**
 * Next project to work on: unfinished work first (so half-built projects get finished),
 * then lowest priority number, then oldest.
 */
export function nextProject(projects: Project[]): Project | undefined {
  return projects
    .filter((p) => p.status === 'queued' || p.status === 'in_progress')
    .sort(
      (a, b) =>
        Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
        a.priority - b.priority ||
        a.createdAt.localeCompare(b.createdAt),
    )[0];
}
