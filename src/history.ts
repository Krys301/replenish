import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from './config.ts';
import type { Usage } from './providers/types.ts';

/**
 * Usage history: one sample per check, so Replenish can learn how fast *the person* uses their
 * plan, with Replenish's own runs excluded.
 *
 * - `idle`: taken while no Replenish run was going.
 * - `run-end`: taken right after a run finished.
 *
 * Only the gap between a sample that isn't the start of a run and a later `idle` sample is the
 * person's own usage. Gaps that end in `run-end` contain Replenish's usage and are skipped.
 */

export type SampleSource = 'idle' | 'run-end';

export interface Sample {
  t: string;
  source: SampleSource;
  weekly?: number;
  weeklyResetsAt?: string;
  session?: number;
}

const KEEP_DAYS = 35;
const HOUR = 3_600_000;

export function recordSample(usage: Usage, source: SampleSource, now = new Date()): Sample {
  const sample: Sample = {
    t: now.toISOString(),
    source,
    weekly: usage.weekly?.percentUsed,
    weeklyResetsAt: usage.weekly?.resetsAt,
    session: usage.session?.percentUsed,
  };
  mkdirSync(dirname(PATHS.history), { recursive: true });
  appendFileSync(PATHS.history, JSON.stringify(sample) + '\n');
  return sample;
}

export function loadSamples(now = new Date()): Sample[] {
  if (!existsSync(PATHS.history)) return [];
  const all: Sample[] = [];
  for (const line of readFileSync(PATHS.history, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  const cutoff = now.getTime() - KEEP_DAYS * 24 * HOUR;
  const kept = all.filter((s) => Date.parse(s.t) >= cutoff).sort((a, b) => a.t.localeCompare(b.t));
  if (kept.length < all.length) writeFileSync(PATHS.history, kept.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return kept;
}

export interface UserPace {
  /** The person's own weekly-limit usage, in % per hour, averaged over observed time. */
  ratePerHour: number;
  /** How many hours of the person's own usage we've actually observed. */
  observedHours: number;
  /** True when the person used Claude in the most recent interval (they're active right now). */
  activeNow: boolean;
}

/** Hours of observation needed before trusting the learned pace over the simple reset-window rule. */
export const MIN_OBSERVED_HOURS = 24;
const MAX_GAP_HOURS = 48;

export function userPace(samples: Sample[], now = new Date(), lookbackDays = 14): UserPace {
  const since = now.getTime() - lookbackDays * 24 * HOUR;
  let used = 0;
  let hours = 0;
  let activeNow = false;

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b.source !== 'idle') continue; // interval contains a Replenish run
    const ta = Date.parse(a.t);
    const tb = Date.parse(b.t);
    if (ta < since || a.weekly === undefined || b.weekly === undefined) continue;
    const gap = (tb - ta) / HOUR;
    if (gap <= 0 || gap > MAX_GAP_HOURS) continue;
    const sameWeek = a.weeklyResetsAt && b.weeklyResetsAt && Math.abs(Date.parse(a.weeklyResetsAt) - Date.parse(b.weeklyResetsAt)) < HOUR;
    if (!sameWeek) continue; // the limit reset in between; the delta is meaningless

    const delta = Math.max(0, b.weekly - a.weekly);
    used += delta;
    hours += gap;

    // The latest interval, if recent, tells us whether the person is using Claude right now.
    if (i === samples.length - 1 && now.getTime() - tb < 2 * HOUR) {
      const sessionDelta = (b.session ?? 0) - (a.session ?? 0);
      activeNow = delta >= 1 || sessionDelta >= 3;
    }
  }
  return { ratePerHour: hours > 0 ? used / hours : 0, observedHours: hours, activeNow };
}
