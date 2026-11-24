import { PATHS } from './config.js';
import { readJson, slugify, writeJson } from './fsutil.js';
export function loadQueue() {
    return readJson(PATHS.queue, { projects: [] }).projects;
}
export function saveQueue(projects) {
    writeJson(PATHS.queue, { projects });
}
export function addProject(input) {
    const projects = loadQueue();
    const name = input.name?.trim() || input.brief.split(/[.\n]/)[0].trim().slice(0, 60);
    let id = slugify(name);
    for (let n = 2; projects.some((p) => p.id === id); n++)
        id = `${slugify(name)}-${n}`;
    const project = {
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
export function updateProject(id, patch) {
    const projects = loadQueue();
    const i = projects.findIndex((p) => p.id === id);
    if (i < 0)
        throw new Error(`No project "${id}"`);
    projects[i] = { ...projects[i], ...patch };
    saveQueue(projects);
    return projects[i];
}
export function removeProject(id) {
    const projects = loadQueue();
    const next = projects.filter((p) => p.id !== id);
    saveQueue(next);
    return next.length !== projects.length;
}
/**
 * Next project to work on: unfinished work first (so half-built projects get finished),
 * then lowest priority number, then oldest.
 */
export function nextProject(projects) {
    return projects
        .filter((p) => p.status === 'queued' || p.status === 'in_progress')
        .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
        a.priority - b.priority ||
        a.createdAt.localeCompare(b.createdAt))[0];
}
