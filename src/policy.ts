import type { Config } from './config.ts';
import type { Usage } from './providers/types.ts';

export type Decision = { start: true; reason: string } | { start: false; reason: string };

const pct = (n: number) => `${Math.round(n)}%`;

export function hoursUntil(iso: string, now: Date): number {
  return (Date.parse(iso) - now.getTime()) / 3_600_000;
}

/** Should an idle Replenish start spending leftover usage right now? */
export function shouldStart(usage: Usage, cfg: Config, now: Date): Decision {
  const { weekly, session } = usage;
  if (!weekly) return { start: false, reason: 'No weekly limit reported for this account (API key or unsupported plan).' };

  const hours = hoursUntil(weekly.resetsAt, now);
  const left = 100 - weekly.percentUsed;

  if (hours <= 0) return { start: false, reason: 'Weekly limit is resetting now; waiting for fresh numbers.' };
  if (hours > cfg.windowHours) {
    return {
      start: false,
      reason: `Weekly reset is ${hours.toFixed(1)}h away; Replenish starts within ${cfg.windowHours}h of reset. (${pct(left)} left)`,
    };
  }
  if (weekly.percentUsed >= cfg.stopAtPercent || left < cfg.minLeftPercent) {
    return { start: false, reason: `Only ${pct(left)} of the weekly limit left; nothing worth replenishing.` };
  }
  if (session && session.percentUsed >= cfg.stopAtPercent) {
    return {
      start: false,
      reason: `5-hour limit is at ${pct(session.percentUsed)}; waiting for it to reset (${hoursUntil(session.resetsAt, now).toFixed(1)}h).`,
    };
  }
  return {
    start: true,
    reason: `${pct(left)} of the weekly limit is unused and it resets in ${hours.toFixed(1)}h.`,
  };
}

/** Should a running job stop? `startedWeekResetAt` pins the week the job was started in. */
export function shouldStop(usage: Usage, cfg: Config, startedWeekResetAt: string): string | undefined {
  const { weekly, session } = usage;
  if (!weekly) return 'Weekly limit info disappeared.';
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
  return undefined;
}
