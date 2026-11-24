import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './fsutil.ts';

export const HOME = process.env.REPLENISH_HOME ?? join(homedir(), '.replenish');
export const PATHS = {
  config: join(HOME, 'config.json'),
  queue: join(HOME, 'queue.json'),
  lock: join(HOME, 'run.lock'),
  logs: join(HOME, 'logs'),
  reports: join(HOME, 'reports'),
};

export interface Config {
  /** Which AI subscription to spend. Only "claude" exists today. */
  provider: 'claude';
  /** Start spending once the weekly limit resets within this many hours. */
  windowHours: number;
  /** Don't bother starting if less than this % of the weekly limit is left. */
  minLeftPercent: number;
  /** Stop a run once weekly (or 5-hour) usage reaches this %. Keeps headroom for you. */
  stopAtPercent: number;
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
  windowHours: 24,
  minLeftPercent: 10,
  stopAtPercent: 95,
  checkIntervalSeconds: 60,
  projectsDir: join(homedir(), 'Replenish'),
  permissionMode: 'auto',
};

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
  if (!(key in DEFAULTS) && key !== 'model' && key !== 'claudePath') {
    throw new Error(`Unknown config key "${key}". Keys: ${[...Object.keys(DEFAULTS), 'model', 'claudePath'].join(', ')}`);
  }
  const sample = (DEFAULTS as unknown as Record<string, unknown>)[key];
  if (typeof sample === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
    return n;
  }
  if (key === 'permissionMode' && !['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions'].includes(raw)) {
    throw new Error('permissionMode must be one of: auto, acceptEdits, dontAsk, bypassPermissions');
  }
  return raw;
}
