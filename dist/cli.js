#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { coerceConfigValue, loadConfig, PATHS, saveConfig } from './config.js';
import { loadSamples, MIN_OBSERVED_HOURS, quietHours, recordSample, userPace } from './history.js';
import { forecast, hoursUntil, resolveActiveHours, shouldStart } from './policy.js';
import { makeProvider, runInProgress, tick } from './runner.js';
import { install, uninstall } from './schedule.js';
import { findProject, lastMessage, openFolder, resultSummary } from './results.js';
import { addProject, loadQueue, nextProject, removeProject, updateProject } from './store.js';
const HELP = `replenish: spend leftover AI plan usage on projects you never got around to building

Usage:
  replenish add "<brief>" [--name <name>] [--priority <1-5>] [--repo <path>] [--file <brief.md>]
  replenish list                     Show the queue
  replenish remove <id>              Delete a project from the queue
  replenish requeue <id>             Put a done/blocked/failed project back in the queue
  replenish show [<id>]              Where your built projects are (all, or one in detail)
  replenish open [<id>] [--folder]   Open a project in VS Code (or File Explorer). Default: the latest
  replenish status                   Usage, the start decision, and what's next
  replenish analyze                  Your usage by hour of day, and your quiet hours
  replenish pause | resume           Kill switch: stop everything now / re-enable
  replenish install | uninstall      Run automatically every hour (Task Scheduler / cron)
  replenish tick [--dry-run]         One scheduler check (what the hourly job runs)
  replenish run [<id>]               Start now, without waiting for the reset window
  replenish config [<key> [<value>]] Show or change settings

How it works: every hour Replenish checks your Claude usage and learns your normal pace (Replenish's
own runs excluded). When it forecasts that part of your weekly limit will go unused by the reset, it
builds the next queued project with that spare, keeping back what you're expected to need, then picks
up where it left off next time. Until it has a day of history, it only uses what's left in the
last ${'`windowHours`'} before the reset.
Data lives in ${PATHS.config.replace(/[\\/]config\.json$/, '')}.`;
const bar = (pct, width = 20) => {
    const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
};
async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const cfg = loadConfig();
    switch (command) {
        case 'add': {
            const { values, positionals } = parseArgs({
                args: rest,
                allowPositionals: true,
                options: { name: { type: 'string' }, priority: { type: 'string' }, repo: { type: 'string' }, file: { type: 'string' } },
            });
            const brief = values.file ? readFileSync(values.file, 'utf8') : positionals.join(' ');
            if (!brief.trim())
                throw new Error('Give a brief: replenish add "A habit tracker PWA with streaks and reminders"');
            if (brief.trim().length < 40) {
                console.warn('Tip: longer briefs build better projects. Say what it is, who it is for, key features, and any tech preferences.');
            }
            const p = addProject({
                brief,
                name: values.name,
                priority: values.priority ? Number(values.priority) : undefined,
                repo: values.repo ? resolve(values.repo) : undefined,
            });
            console.log(`Queued "${p.name}" as ${p.id} (priority ${p.priority}).`);
            return;
        }
        case 'show': {
            const queue = loadQueue();
            if (rest[0]) {
                const p = findProject(queue, rest[0]);
                if (!p)
                    throw new Error(`No project matching "${rest[0]}". See: replenish list`);
                console.log(resultSummary(p));
                const msg = lastMessage(p);
                if (msg)
                    console.log(`\nClaude's summary:\n\n${msg}`);
                return;
            }
            const built = queue.filter((p) => p.workDir);
            if (!built.length)
                return console.log('Nothing built yet. Queue an idea with: replenish add "..."');
            console.log(`Your projects live in ${cfg.projectsDir}\n`);
            for (const p of built)
                console.log(resultSummary(p) + '\n');
            console.log('Details for one: replenish show <id>    Open one: replenish open <id>');
            return;
        }
        case 'open': {
            const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { folder: { type: 'boolean' } } });
            const p = findProject(loadQueue(), positionals[0]);
            if (!p)
                throw new Error(positionals[0] ? `No project matching "${positionals[0]}". See: replenish list` : 'Nothing has been built yet.');
            if (!p.workDir || !existsSync(p.workDir))
                throw new Error(`"${p.name}" hasn't been built yet.`);
            const app = openFolder(p.workDir, !values.folder);
            console.log(`Opened "${p.name}" in ${app}:\n  ${p.workDir}`);
            return;
        }
        case 'list': {
            const queue = loadQueue();
            if (!queue.length)
                return console.log('Queue is empty. Add one with: replenish add "<what to build>"');
            const next = nextProject(queue)?.id;
            for (const p of queue) {
                const last = p.runs.at(-1);
                console.log(`${p.id === next ? '→' : ' '} ${p.id.padEnd(28)} P${p.priority}  ${p.status.padEnd(11)} ${p.runs.length} run(s)${last ? `, last: ${last.outcome}` : ''}`);
            }
            if (queue.some((p) => p.workDir))
                console.log('\nWhere are they? replenish show    Open one: replenish open <id>');
            return;
        }
        case 'remove': {
            const id = need(rest[0], 'id');
            console.log(removeProject(id) ? `Removed ${id}.` : `No project "${id}".`);
            return;
        }
        case 'requeue': {
            const id = need(rest[0], 'id');
            updateProject(id, { status: 'queued' });
            console.log(`${id} is back in the queue (its work so far is kept).`);
            return;
        }
        case 'status': {
            const usage = await makeProvider(cfg).getUsage();
            const now = new Date();
            console.log(`Plan: ${usage.plan ?? 'unknown'}`);
            if (usage.weekly) {
                console.log(`Weekly   ${bar(usage.weekly.percentUsed)} ${usage.weekly.percentUsed}% used, resets in ${hoursUntil(usage.weekly.resetsAt, now).toFixed(1)}h`);
            }
            if (usage.session) {
                console.log(`5-hour   ${bar(usage.session.percentUsed)} ${usage.session.percentUsed}% used, resets in ${hoursUntil(usage.session.resetsAt, now).toFixed(1)}h`);
            }
            const running = runInProgress();
            if (!running)
                recordSample(usage, 'idle', now);
            const pace = userPace(loadSamples(now), now);
            const f = forecast(usage, cfg, now, pace);
            console.log('');
            if (cfg.strategy === 'deadline') {
                console.log(`Strategy: deadline (spend what's left in the last ${cfg.windowHours}h before reset)`);
            }
            else if (f) {
                console.log(`Your pace  ~${f.perDay.toFixed(1)}% of the weekly limit per day (from ${Math.round(pace.observedHours)}h of history)`);
                console.log(`Forecast   ~${Math.round(f.projectedAtReset)}% used by reset if Replenish does nothing`);
                console.log(`Spare now  ${Math.max(0, f.spare).toFixed(0)}% (Replenish may go up to ${Math.max(0, f.ceiling).toFixed(0)}% now, rising to ${cfg.stopAtPercent}% at reset)`);
            }
            else {
                console.log(`Learning your pace: ${Math.floor(pace.observedHours)}h of ${MIN_OBSERVED_HOURS}h observed. Until then, the last-${cfg.windowHours}h-before-reset rule applies.`);
            }
            if (existsSync(PATHS.stop))
                console.log('PAUSED (kill switch on). Run `replenish resume` to re-enable.');
            if (cfg.activeHours) {
                const active = resolveActiveHours(cfg, pace);
                console.log(`Active hours: ${cfg.activeHours === 'auto' ? `auto (your quiet hours: ${active || 'still learning, so any time'})` : active}`);
            }
            console.log(running ? '\nA Replenish run is in progress right now.' : `\n${shouldStart(usage, cfg, now, pace).reason}`);
            const next = nextProject(loadQueue());
            console.log(next ? `Next up: ${next.name} (${next.id})` : 'Queue is empty.');
            return;
        }
        case 'pause':
            writeFileSync(PATHS.stop, `Paused ${new Date().toISOString()}
`);
            console.log('Paused. Nothing new will start, and a running build stops at its next usage check (within a minute).');
            console.log('Re-enable with: replenish resume');
            return;
        case 'resume':
            rmSync(PATHS.stop, { force: true });
            console.log('Resumed.');
            return;
        case 'analyze': {
            const now = new Date();
            const pace = userPace(loadSamples(now), now);
            if (pace.observedHours === 0)
                return console.log('No usage history yet. It builds up from each hourly check (`replenish install`).');
            console.log(`Your own Claude usage by hour of day (last 14 days, ${Math.round(pace.observedHours)}h observed, Replenish runs excluded):
`);
            const peak = Math.max(...pace.byHour, 1e-9);
            for (let h = 0; h < 24; h++) {
                const r = pace.byHour[h];
                const thin = pace.observedByHour[h] < 3 ? '  (little data)' : '';
                console.log(`  ${String(h).padStart(2, '0')}:00  ${'█'.repeat(Math.round((r / peak) * 30)).padEnd(30)} ${r.toFixed(2)}%/h${thin}`);
            }
            console.log(`
Average: ${(pace.ratePerHour * 24).toFixed(1)}% of your weekly limit per day.`);
            const quiet = quietHours(pace);
            if (quiet) {
                console.log(`Your quiet hours: ${quiet}. To have Replenish build only then: replenish config activeHours auto`);
            }
            else {
                console.log(pace.observedHours < MIN_OBSERVED_HOURS ? `Quiet hours: need ${MIN_OBSERVED_HOURS}h of history first.` : 'No clear quiet hours yet.');
            }
            return;
        }
        case 'tick': {
            const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' } } });
            await tick(cfg, { dryRun: values['dry-run'] });
            return;
        }
        case 'run': {
            const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
            await tick(cfg, { force: true, projectId: positionals[0], dryRun: values['dry-run'] });
            return;
        }
        case 'install':
            console.log(install());
            console.log(`Replenish will start within ${cfg.windowHours}h of your weekly reset when at least ${cfg.minLeftPercent}% is left, and stop at ${cfg.stopAtPercent}%.`);
            return;
        case 'uninstall':
            console.log(uninstall());
            return;
        case 'config': {
            const [key, value] = rest;
            if (key && value !== undefined) {
                saveConfig({ [key]: coerceConfigValue(key, value) });
            }
            const now = loadConfig();
            for (const [k, v] of Object.entries(now))
                console.log(`${k.padEnd(22)} ${v}`);
            return;
        }
        case undefined:
        case 'help':
        case '--help':
        case '-h':
            console.log(HELP);
            return;
        default:
            throw new Error(`Unknown command "${command}". Run: replenish help`);
    }
}
function need(v, what) {
    if (!v)
        throw new Error(`Missing ${what}.`);
    return v;
}
main().catch((err) => {
    console.error(`replenish: ${err.message}`);
    process.exit(1);
});
