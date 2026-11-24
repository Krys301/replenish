import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function readJson(path, fallback) {
    if (!existsSync(path))
        return fallback;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (err) {
        throw new Error(`Could not parse ${path}: ${err.message}`);
    }
}
/** Write via a temp file + rename so a crash never leaves half-written JSON. */
export function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, path);
}
export function slugify(text) {
    return (text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '') || 'project');
}
