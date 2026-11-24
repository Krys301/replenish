import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
/**
 * "Where did my project go?" Everything the person needs to find and open a build's result:
 * printed at the end of every run, and by `replenish show`.
 */
function commitCount(dir) {
    try {
        return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    }
    catch {
        return 0;
    }
}
const HEADLINE = {
    done: '✅ Finished',
    in_progress: '⏸  In progress (continues on the next run)',
    blocked: '⚠️  Needs you',
    failed: '❌ Failed',
    queued: '•  Queued (not started yet)',
};
/** The block shown when a run ends and by `replenish show <id>`. */
export function resultSummary(p) {
    const lines = [`${HEADLINE[p.status]}: ${p.name}`];
    const dir = p.workDir;
    if (!dir || !existsSync(dir)) {
        lines.push('   Nothing built yet.');
        return frame(lines);
    }
    lines.push(`   Folder:     ${dir}`);
    lines.push(`   Open it:    replenish open ${p.id}`);
    const readFirst = ['README.md', 'REPLENISH.md'].filter((f) => existsSync(join(dir, f)));
    if (p.status === 'blocked') {
        lines.push('   What it needs: see REPLENISH.md in the folder, then run: replenish requeue ' + p.id);
    }
    else if (readFirst.length) {
        const why = { 'README.md': 'how to use it', 'REPLENISH.md': 'what was built, decisions, next steps' };
        lines.push(`   Read first: ${readFirst.map((f) => `${f} (${why[f]})`).join(', ')}`);
    }
    const report = p.runs.at(-1)?.report;
    if (report && existsSync(report))
        lines.push(`   Report:     ${report}`);
    const commits = commitCount(dir);
    const where = p.repo ? `on branch replenish/${p.id} of ${p.repo}` : 'a local git repo';
    lines.push(`   It's ${where} with ${commits} commit${commits === 1 ? '' : 's'}. Nothing was pushed online.`);
    return frame(lines);
}
function frame(lines) {
    const rule = '─'.repeat(Math.min(72, process.stdout.columns ? process.stdout.columns - 1 : 72));
    return [rule, ...lines, rule].join('\n');
}
/** Claude's final message from the latest report, for `replenish show`. */
export function lastMessage(p, maxLines = 25) {
    const report = p.runs.at(-1)?.report;
    if (!report || !existsSync(report))
        return undefined;
    const md = readFileSync(report, 'utf8');
    const m = md.match(/## Claude's last message\s*\n([\s\S]*?)\n## Commits/);
    const body = m?.[1]?.replace(/\n?REPLENISH_STATUS:.*$/m, '').trim();
    if (!body || body === '(none)')
        return undefined;
    const all = body.split('\n');
    return all.slice(0, maxLines).join('\n') + (all.length > maxLines ? `\n… (full message in the report)` : '');
}
/** Find a project by exact id, id prefix, or "last" (most recently run). */
export function findProject(projects, query) {
    if (!query || query === 'last') {
        return [...projects].filter((p) => p.runs.length).sort((a, b) => (a.runs.at(-1).endedAt < b.runs.at(-1).endedAt ? 1 : -1))[0];
    }
    return projects.find((p) => p.id === query) ?? projects.filter((p) => p.id.startsWith(query)).at(0);
}
function onPath(cmd) {
    const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
    return (process.env.PATH ?? '').split(delimiter).some((d) => exts.some((e) => existsSync(join(d, cmd + e))));
}
/** Open a folder in VS Code if it's installed, otherwise in the file manager. */
export function openFolder(dir, preferEditor = true) {
    if (preferEditor && onPath('code')) {
        spawn(process.platform === 'win32' ? `code "${dir}"` : 'code', process.platform === 'win32' ? [] : [dir], {
            shell: process.platform === 'win32',
            detached: true,
            stdio: 'ignore',
        }).unref();
        return 'VS Code';
    }
    const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
    return process.platform === 'win32' ? 'File Explorer' : process.platform === 'darwin' ? 'Finder' : 'your file manager';
}
