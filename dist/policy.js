import { expectedUsage, MIN_OBSERVED_HOURS, quietHours } from './history.js';
const pct = (n) => `${Math.round(n)}%`;
export function hoursUntil(iso, now) {
    return (Date.parse(iso) - now.getTime()) / 3_600_000;
}
/**
 * The hours Replenish may run in. "auto" means the person's learned quiet hours (any time until
 * there's enough history to know them).
 */
export function resolveActiveHours(cfg, pace) {
    if (cfg.activeHours !== 'auto')
        return cfg.activeHours;
    return (pace && quietHours(pace)) ?? '';
}
/** "22-7" → true between 22:00 and 07:00 local time. Empty = any time. */
export function inActiveHours(spec, now) {
    if (!spec.trim())
        return true;
    const m = spec.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
    if (!m)
        return true;
    const from = Number(m[1]) % 24;
    const to = Number(m[2]) % 24;
    const h = now.getHours();
    if (from === to)
        return true;
    return from < to ? h >= from && h < to : h >= from || h < to;
}
/** Undefined when there's not enough history yet (or the strategy is "deadline"). */
export function forecast(usage, cfg, now, pace) {
    if (cfg.strategy !== 'pace' || !pace || pace.observedHours < MIN_OBSERVED_HOURS || !usage.weekly)
        return undefined;
    // Hour-by-hour: what the person usually uses in each of the hours left before the reset.
    const expectedNeed = expectedUsage(pace, now.getTime(), Math.max(now.getTime(), Date.parse(usage.weekly.resetsAt)));
    const ceiling = cfg.stopAtPercent - expectedNeed * cfg.safetyFactor;
    return {
        perDay: pace.ratePerHour * 24,
        projectedAtReset: Math.min(100, usage.weekly.percentUsed + expectedNeed),
        ceiling,
        spare: ceiling - usage.weekly.percentUsed,
    };
}
/** Should an idle Replenish start spending unused usage right now? */
export function shouldStart(usage, cfg, now, pace) {
    const { weekly, session } = usage;
    if (!weekly)
        return { start: false, reason: 'No weekly limit reported for this account (API key or unsupported plan).' };
    const hours = hoursUntil(weekly.resetsAt, now);
    if (hours <= 0)
        return { start: false, reason: 'Weekly limit is resetting now; waiting for fresh numbers.' };
    if (session && session.percentUsed >= cfg.stopAtPercent) {
        return { start: false, reason: `5-hour limit is at ${pct(session.percentUsed)}; waiting for it to reset (${hoursUntil(session.resetsAt, now).toFixed(1)}h).` };
    }
    const active = resolveActiveHours(cfg, pace);
    if (!inActiveHours(active, now)) {
        return { start: false, reason: `Outside the hours Replenish runs in (${active}${cfg.activeHours === 'auto' ? ', your quiet hours' : ''}).` };
    }
    if (cfg.skipIfUserActive && pace?.activeNow) {
        return { start: false, reason: "You're using Claude right now; Replenish won't compete with you." };
    }
    const f = forecast(usage, cfg, now, pace);
    if (f) {
        const outlook = `You use about ${pct(f.perDay)}/day, so you'd reach ~${pct(f.projectedAtReset)} by the reset in ${hours.toFixed(1)}h.`;
        if (f.spare < cfg.minLeftPercent) {
            return { start: false, reason: `${outlook} Only ${pct(Math.max(0, f.spare))} is safely spare (need ${cfg.minLeftPercent}%).` };
        }
        return { start: true, reason: `${outlook} ~${pct(f.spare)} would go unused, so Replenish can spend up to ${pct(f.ceiling)}.` };
    }
    // Not enough history yet (or strategy "deadline"): only use what's left close to the reset.
    const learning = cfg.strategy === 'pace' ? ` (Still learning your usage pace: ${Math.floor(pace?.observedHours ?? 0)}h of ${MIN_OBSERVED_HOURS}h observed.)` : '';
    const left = 100 - weekly.percentUsed;
    if (hours > cfg.windowHours) {
        return { start: false, reason: `Weekly reset is ${hours.toFixed(1)}h away; waiting until ${cfg.windowHours}h before it. (${pct(left)} left)${learning}` };
    }
    if (weekly.percentUsed >= cfg.stopAtPercent || left < cfg.minLeftPercent) {
        return { start: false, reason: `Only ${pct(left)} of the weekly limit left; nothing worth replenishing.${learning}` };
    }
    return { start: true, reason: `${pct(left)} of the weekly limit is unused and it resets in ${hours.toFixed(1)}h.${learning}` };
}
/** Should a running job stop? `startedWeekResetAt` pins the week the job was started in. */
export function shouldStop(usage, cfg, startedWeekResetAt, now, pace) {
    const { weekly, session } = usage;
    if (!weekly)
        return 'Weekly limit info disappeared.';
    // The server recomputes resets_at on every call (sub-second jitter), so only a jump of an hour
    // or more means the window actually rolled over.
    if (Date.parse(weekly.resetsAt) - Date.parse(startedWeekResetAt) > 3_600_000) {
        return 'The weekly limit reset; stopping so the new week stays yours.';
    }
    if (weekly.percentUsed >= cfg.stopAtPercent) {
        return `Weekly usage reached ${pct(weekly.percentUsed)} (cap ${cfg.stopAtPercent}%).`;
    }
    if (session && session.percentUsed >= cfg.stopAtPercent) {
        return `5-hour usage reached ${pct(session.percentUsed)}; will continue after it resets.`;
    }
    const f = forecast(usage, cfg, now, pace);
    if (f && weekly.percentUsed >= f.ceiling) {
        return `Used the spare: weekly is at ${pct(weekly.percentUsed)}, and the rest is kept for your usual ~${pct(f.perDay)}/day until the reset.`;
    }
    const active = resolveActiveHours(cfg, pace);
    if (!inActiveHours(active, now)) {
        return `Active hours (${active}) ended; will continue next time.`;
    }
    return undefined;
}
