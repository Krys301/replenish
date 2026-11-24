#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { coerceConfigValue, loadConfig, PATHS, saveConfig, type Config } from './config.ts';
import { hoursUntil, shouldStart } from './policy.ts';
import { makeProvider, tick } from './runner.ts';
import { install, uninstall } from './schedule.ts';
import { addProject, loadQueue, nextProject, removeProject, updateProject } from './store.ts';

const HELP = `replenish: spend leftover AI plan usage on projects you never got around to building

Usage:
  replenish add "<brief>" [--name <name>] [--priority <1-5>] [--repo <path>] [--file <brief.md>]
  replenish list                     Show the queue
  replenish remove <id>              Delete a project from the queue
  replenish requeue <id>             Put a done/blocked/failed project back in the queue
  replenish status                   Usage, the start decision, and what's next
  replenish install | uninstall      Run automatically every hour (Task Scheduler / cron)
  replenish tick [--dry-run]         One scheduler check (what the hourly job runs)
  replenish run [<id>]               Start now, without waiting for the reset window
  replenish config [<key> [<value>]] Show or change settings

How it works: every hour Replenish asks Claude Code how much of your weekly limit is used.
Within ${'`windowHours`'} of the weekly reset, if enough is left, it builds the next queued project in
its own folder until usage hits ${'`stopAtPercent`'}, then picks up where it left off next time.
Data lives in ${PATHS.config.replace(/[\\/]config\.json$/, '')}.`;

const bar = (pct: number, width = 20) => {
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
      if (!brief.trim()) throw new Error('Give a brief: replenish add "A habit tracker PWA with streaks and reminders"');
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

    case 'list': {
      const queue = loadQueue();
      if (!queue.length) return console.log('Queue is empty. Add one with: replenish add "<what to build>"');
      const next = nextProject(queue)?.id;
      for (const p of queue) {
        const last = p.runs.at(-1);
        console.log(`${p.id === next ? '→' : ' '} ${p.id.padEnd(28)} P${p.priority}  ${p.status.padEnd(11)} ${p.runs.length} run(s)${last ? `, last: ${last.outcome}` : ''}`);
      }
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
      console.log(`\n${shouldStart(usage, cfg, now).reason}`);
      const next = nextProject(loadQueue());
      console.log(next ? `Next up: ${next.name} (${next.id})` : 'Queue is empty.');
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
        saveConfig({ [key]: coerceConfigValue(key, value) } as Partial<Config>);
      }
      const now = loadConfig();
      for (const [k, v] of Object.entries(now)) console.log(`${k.padEnd(22)} ${v}`);
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

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`Missing ${what}.`);
  return v;
}

main().catch((err) => {
  console.error(`replenish: ${(err as Error).message}`);
  process.exit(1);
});
