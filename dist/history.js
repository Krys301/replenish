import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from './config.js';
const KEEP_DAYS = 35;
const HOUR = 3_600_000;
export function recordSample(usage, source, now = new Date()) {
    const sample = {
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
export function loadSamples(now = new Date()) {
    if (!existsSync(PATHS.history))
        return [];
    const all = [];
    for (const line of readFileSync(PATHS.history, 'utf8').split('\n')) {
        if (!line.trim())
            continue;
        try {
            all.push(JSON.parse(line));
        }
        catch {
            /* skip a torn line */
        }
    }
    const cutoff = now.getTime() - KEEP_DAYS * 24 * HOUR;
    const kept = all.filter((s) => Date.parse(s.t) >= cutoff).sort((a, b) => a.t.localeCompare(b.t));
    if (kept.length < all.length)
        writeFileSync(PATHS.history, kept.map((s) => JSON.stringify(s)).join('\n') + '\n');
    return kept;
}
/** Hours of observation needed before trusting the learned pace over the simple reset-window rule. */
export const MIN_OBSERVED_HOURS = 24;
const MAX_GAP_HOURS = 48;
/** Data needed in an hour-of-day bucket before it overrides the flat average. */
const MIN_BUCKET_HOURS = 3;
/** Spread an interval's usage evenly across the local hours of the day it covers. */
function spreadOverHours(fromMs, toMs, used, usedBy, hoursBy) {
    const total = (toMs - fromMs) / HOUR;
    let t = fromMs;
    while (t < toMs) {
        const d = new Date(t);
        const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const end = Math.min(nextHour, toMs);
        const part = (end - t) / HOUR;
        hoursBy[d.getHours()] += part;
        usedBy[d.getHours()] += (used * part) / total;
        t = end;
    }
}
/** Expected usage (in weekly %) between two times, from the person's hour-of-day profile. */
export function expectedUsage(pace, fromMs, toMs) {
    let sum = 0;
    let t = fromMs;
    while (t < toMs) {
        const d = new Date(t);
        const end = Math.min(new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime(), toMs);
        sum += (pace.byHour[d.getHours()] ?? pace.ratePerHour) * ((end - t) / HOUR);
        t = end;
    }
    return sum;
}
export function userPace(samples, now = new Date(), lookbackDays = 14) {
    const since = now.getTime() - lookbackDays * 24 * HOUR;
    let used = 0;
    let hours = 0;
    let activeNow = false;
    const usedBy = Array(24).fill(0);
    const hoursBy = Array(24).fill(0);
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (b.source !== 'idle')
            continue; // interval contains a Replenish run
        const ta = Date.parse(a.t);
        const tb = Date.parse(b.t);
        if (ta < since || a.weekly === undefined || b.weekly === undefined)
            continue;
        const gap = (tb - ta) / HOUR;
        if (gap <= 0 || gap > MAX_GAP_HOURS)
            continue;
        const sameWeek = a.weeklyResetsAt && b.weeklyResetsAt && Math.abs(Date.parse(a.weeklyResetsAt) - Date.parse(b.weeklyResetsAt)) < HOUR;
        if (!sameWeek)
            continue; // the limit reset in between; the delta is meaningless
        const delta = Math.max(0, b.weekly - a.weekly);
        used += delta;
        hours += gap;
        spreadOverHours(ta, tb, delta, usedBy, hoursBy);
        // The latest interval, if recent, tells us whether the person is using Claude right now.
        if (i === samples.length - 1 && now.getTime() - tb < 2 * HOUR) {
            const sessionDelta = (b.session ?? 0) - (a.session ?? 0);
            activeNow = delta >= 1 || sessionDelta >= 3;
        }
    }
    const ratePerHour = hours > 0 ? used / hours : 0;
    const byHour = usedBy.map((u, h) => (hoursBy[h] >= MIN_BUCKET_HOURS ? u / hoursBy[h] : ratePerHour));
    return { ratePerHour, observedHours: hours, activeNow, byHour, observedByHour: hoursBy };
}
/**
 * The person's quiet hours: the longest run of consecutive hours (wrapping past midnight) where
 * they use less than a quarter of their average. Returned as an activeHours string like "1-8".
 */
export function quietHours(pace) {
    if (pace.observedHours < MIN_OBSERVED_HOURS)
        return undefined;
    const quiet = pace.byHour.map((r, h) => pace.observedByHour[h] >= MIN_BUCKET_HOURS && r <= pace.ratePerHour / 4);
    if (quiet.every(Boolean) || !quiet.some(Boolean))
        return undefined;
    let best = { start: 0, len: 0 };
    for (let start = 0; start < 24; start++) {
        if (!quiet[start] || quiet[(start + 23) % 24])
            continue; // only start at the beginning of a run
        let len = 0;
        while (len < 24 && quiet[(start + len) % 24])
            len++;
        if (len > best.len)
            best = { start, len };
    }
    return best.len >= 3 ? `${best.start}-${(best.start + best.len) % 24}` : undefined;
}
