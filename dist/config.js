import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './fsutil.js';
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
export const DEFAULTS = {
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
export function loadConfig() {
    return { ...DEFAULTS, ...readJson(PATHS.config, {}) };
}
export function saveConfig(patch) {
    const current = readJson(PATHS.config, {});
    const next = { ...current, ...patch };
    writeJson(PATHS.config, next);
    return { ...DEFAULTS, ...next };
}
/** Parse a CLI string into the type the config key expects. */
export function coerceConfigValue(key, raw) {
    if (!(key in DEFAULTS) && !OPTIONAL_KEYS.includes(key)) {
        throw new Error(`Unknown config key "${key}". Keys: ${[...Object.keys(DEFAULTS), ...OPTIONAL_KEYS].join(', ')}`);
    }
    const sample = DEFAULTS[key];
    if (typeof sample === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0)
            throw new Error(`${key} must be a non-negative number`);
        return n;
    }
    if (typeof sample === 'boolean') {
        if (!['true', 'false'].includes(raw))
            throw new Error(`${key} must be true or false`);
        return raw === 'true';
    }
    const choices = {
        strategy: ['pace', 'deadline'],
        permissionMode: ['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions'],
    };
    if (choices[key] && !choices[key].includes(raw))
        throw new Error(`${key} must be one of: ${choices[key].join(', ')}`);
    if (key === 'activeHours' && raw !== '' && raw !== 'auto' && !/^\d{1,2}-\d{1,2}$/.test(raw)) {
        throw new Error('activeHours looks like "22-7" (10pm to 7am), "auto" (your quiet hours), or "" for any time');
    }
    return raw;
}
