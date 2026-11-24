import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './fsutil.ts';

export const HOME = process.env.REPLENISH_HOME ?? join(homedir(), '.replenish');
export const PATHS = {
  config: join(HOME, 'config.json'),
  queue: join(HOME, 'queue.json'),
  history: join(HOME, 'usage-history.jsonl'),
  /** Kill switch: while this file exists Replenish starts nothing and stops any run. */
  stop: join(HOME, 'STOP'),
  lock: join(HOME, 'run.lock'),
  logs: join(HOME, 'logs'),
  reports: join(HOME, 'reports'),
};

export interface Config {
  /** Which AI subscription to spend. Only "claude" exists today. */
  provider: 'claude';
  /**
   * "pace": learn how fast the person uses their plan and spend whatever is forecast to go unused,
   *         any day of the week.
   * "deadline": only spend what's left in the last `windowHours` before the weekly reset.
   * Pace falls back to deadline until it has a day of history.
   */
  strategy: 'pace' | 'deadline';
  /** Pace mode: keep this many times the person's expected remaining usage in reserve. */
  safetyFactor: number;
  /** Deadline mode (and pace fallback): start within this many hours of the weekly reset. */
  windowHours: number;
  /** Don't bother starting unless at least this % of the weekly limit is spare. */
  minLeftPercent: number;
  /** Never let weekly (or 5-hour) usage go past this %. Keeps headroom for you. */
  stopAtPercent: number;
  /**
   * Only run during these local hours, e.g. "22-7" for overnight. "auto" = the person's learned
   * quiet hours. Empty = any time.
   */
  activeHours: string;
  /** Watchdog: force-stop a single Claude session that runs longer than this. */
  maxRunMinutes: number;
  /** Don't start while the person is using Claude themselves. */
  skipIfUserActive: boolean;
  /** How often to re-check usage while a job runs. */
  checkIntervalSeconds: number;
  /** Where new projects get created. */
  projectsDir: string;
  /** Claude Code permission mode for unattended runs. */
  permissionMode: 'auto' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';
  /** Model alias for runs; undefined uses Claude Code's default. */
  model?: string;
  /** Absolute path to the claude executable; resolved from PATH when unset. */
  claudePath?: string;
}

export const DEFAULTS: Config = {
  provider: 'claude',
  strategy: 'pace',
  safetyFactor: 1.5,
  windowHours: 24,
  minLeftPercent: 10,
  stopAtPercent: 95,
  activeHours: '',
  maxRunMinutes: 180,
  skipIfUserActive: true,
  checkIntervalSeconds: 60,
  projectsDir: join(homedir(), 'Replenish'),
  permissionMode: 'auto',
};

const OPTIONAL_KEYS = ['model', 'claudePath'];

export function loadConfig(): Config {
  return { ...DEFAULTS, ...readJson<Partial<Config>>(PATHS.config, {}) };
}

export function saveConfig(patch: Partial<Config>): Config {
  const current = readJson<Partial<Config>>(PATHS.config, {});
  const next = { ...current, ...patch };
  writeJson(PATHS.config, next);
  return { ...DEFAULTS, ...next };
}

/** Parse a CLI string into the type the config key expects. */
export function coerceConfigValue(key: string, raw: string): unknown {
  if (!(key in DEFAULTS) && !OPTIONAL_KEYS.includes(key)) {
    throw new Error(`Unknown config key "${key}". Keys: ${[...Object.keys(DEFAULTS), ...OPTIONAL_KEYS].join(', ')}`);
  }
  const sample = (DEFAULTS as unknown as Record<string, unknown>)[key];
  if (typeof sample === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
    return n;
  }
  if (typeof sample === 'boolean') {
    if (!['true', 'false'].includes(raw)) throw new Error(`${key} must be true or false`);
    return raw === 'true';
  }
  const choices: Record<string, string[]> = {
    strategy: ['pace', 'deadline'],
    permissionMode: ['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions'],
  };
  if (choices[key] && !choices[key].includes(raw)) throw new Error(`${key} must be one of: ${choices[key].join(', ')}`);
  if (key === 'activeHours' && raw !== '' && raw !== 'auto' && !/^\d{1,2}-\d{1,2}$/.test(raw)) {
    throw new Error('activeHours looks like "22-7" (10pm to 7am), "auto" (your quiet hours), or "" for any time');
  }
  return raw;
}
