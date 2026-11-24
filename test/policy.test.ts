import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, type Config } from '../src/config.ts';
import { expectedUsage, quietHours, userPace, type Sample } from '../src/history.ts';
import { forecast, inActiveHours, resolveActiveHours, shouldStart, shouldStop } from '../src/policy.ts';
import { parseUsage } from '../src/providers/claude.ts';
import { parseStatus } from '../src/runner.ts';
import { nextProject, type Project } from '../src/store.ts';

const now = new Date('2026-11-26T12:00:00Z');
const H = 3_600_000;
const inHours = (h: number) => new Date(now.getTime() + h * H).toISOString();
const usage = (weekly: number, resetH: number, session = 0) => ({
  weekly: { percentUsed: weekly, resetsAt: inHours(resetH) },
  session: { percentUsed: session, resetsAt: inHours(2) },
});
const deadline: Config = { ...DEFAULTS, strategy: 'deadline' };

/** Hourly idle samples over `hours`, using `perHour` % of the weekly limit each hour. */
function history(hours: number, perHour: number, resetH = 100): Sample[] {
  return Array.from({ length: hours + 1 }, (_, i) => ({
    t: new Date(now.getTime() - (hours - i) * H).toISOString(),
    source: 'idle' as const,
    weekly: 10 + i * perHour,
    weeklyResetsAt: inHours(resetH),
    session: 0,
  }));
}

// ---------- deadline rule (also the fallback while learning) ----------

test('deadline: waits when the weekly reset is far away', () => {
  const d = shouldStart(usage(10, 72), deadline, now);
  assert.equal(d.start, false);
  assert.match(d.reason, /72\.0h away/);
});

test('deadline: starts near the reset with plenty left', () => {
  assert.equal(shouldStart(usage(40, 10), deadline, now).start, true);
});

test('deadline: skips when little is left', () => {
  assert.equal(shouldStart(usage(93, 10), deadline, now).start, false);
});

test('pace without enough history falls back to the deadline rule', () => {
  const pace = userPace(history(5, 0.2), now);
  const d = shouldStart(usage(10, 72), DEFAULTS, now, pace);
  assert.equal(d.start, false);
  assert.match(d.reason, /learning/i);
});

// ---------- learning the person's pace ----------

test('learns the hourly rate from idle samples', () => {
  const pace = userPace(history(48, 0.25), now);
  assert.equal(pace.observedHours, 48);
  assert.ok(Math.abs(pace.ratePerHour - 0.25) < 1e-9);
});

test("excludes Replenish's own runs from the person's pace", () => {
  const s = history(48, 0.25);
  // A run that burned 30% between hour 20 and 21: the interval ending in run-end is ignored,
  // and so are later samples measured from the jumped baseline only through valid intervals.
  s[21] = { ...s[21]!, source: 'run-end', weekly: s[20]!.weekly! + 30 };
  for (let i = 22; i < s.length; i++) s[i] = { ...s[i]!, weekly: s[i]!.weekly! + 30 - 0.25 };
  const pace = userPace(s, now);
  assert.ok(pace.ratePerHour < 0.3, `rate ${pace.ratePerHour} should not include the run`);
});

test('ignores intervals across a weekly reset', () => {
  const s = history(30, 0.5);
  for (let i = 15; i < s.length; i++) s[i] = { ...s[i]!, weekly: i - 15, weeklyResetsAt: inHours(268) };
  const pace = userPace(s, now);
  assert.ok(pace.observedHours < 30);
});

test('detects that the person is using Claude right now', () => {
  const s = history(30, 0);
  s[s.length - 1] = { ...s.at(-1)!, weekly: s.at(-2)!.weekly! + 3 };
  assert.equal(userPace(s, now).activeNow, true);
  assert.equal(userPace(history(30, 0), now).activeNow, false);
});

// ---------- pace strategy ----------

test('light user mid-week: starts early to use the forecast spare', () => {
  // 0.1%/h ≈ 2.4%/day; 72h left → needs ~7.2% (×1.5 safety = 10.8). At 20% now: ceiling ≈ 84%.
  const pace = userPace(history(48, 0.1), now);
  const d = shouldStart(usage(20, 72), DEFAULTS, now, pace);
  assert.equal(d.start, true, d.reason);
  const f = forecast(usage(20, 72), DEFAULTS, now, pace)!;
  assert.ok(Math.abs(f.ceiling - (95 - 0.1 * 72 * 1.5)) < 1e-6);
});

test('heavy user: no spare, so it waits', () => {
  // 1%/h → would use 72% more in 72h. 30% now → already over the line.
  const pace = userPace(history(48, 1), now);
  assert.equal(shouldStart(usage(30, 72), DEFAULTS, now, pace).start, false);
});

test("pace: stops once the spare is used, keeping the person's reserve", () => {
  const pace = userPace(history(48, 0.5), now); // reserve for 72h = 36% × 1.5 = 54 → ceiling 41
  assert.equal(shouldStop(usage(30, 72), DEFAULTS, inHours(72), now, pace), undefined);
  assert.match(shouldStop(usage(42, 72), DEFAULTS, inHours(72), now, pace)!, /spare/);
});

test("won't compete with the person while they're active", () => {
  const s = history(48, 0.1);
  s[s.length - 1] = { ...s.at(-1)!, weekly: s.at(-2)!.weekly! + 2 };
  const d = shouldStart(usage(20, 72), DEFAULTS, now, userPace(s, now));
  assert.equal(d.start, false);
  assert.match(d.reason, /using Claude right now/);
});

// ---------- hour-of-day profile ----------

/** `days` of hourly samples for a 9-to-5 user: `perHour` % in each work hour, nothing otherwise. */
function workdayHistory(days: number, perHour: number, end: Date): Sample[] {
  const out: Sample[] = [];
  let weekly = 0;
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days, end.getHours());
  for (let t = start.getTime(); t <= end.getTime(); t += H) {
    const h = new Date(t).getHours();
    out.push({ t: new Date(t).toISOString(), source: 'idle', weekly, weeklyResetsAt: '2030-01-01T00:00:00Z', session: 0 });
    if (h >= 9 && h < 17) weekly += perHour;
  }
  return out;
}

test("learns which hours of the day the person uses Claude", () => {
  const end = new Date(2026, 10, 26, 23, 0);
  const pace = userPace(workdayHistory(10, 1, end), end);
  assert.ok(pace.byHour[12]! > 0.9 && pace.byHour[12]! < 1.1, `noon ${pace.byHour[12]}`);
  assert.ok(pace.byHour[3]! < 0.01, `3am ${pace.byHour[3]}`);
  assert.equal(quietHours(pace), '17-9');
});

test('forecast counts only the hours the person actually works', () => {
  const end = new Date(2026, 10, 26, 18, 0); // 6pm, work day over
  const pace = userPace(workdayHistory(10, 1, end), end);
  // Next 12 hours run 6pm-6am: all quiet, so expect ~0, where a flat average would say 4%.
  const hourly = expectedUsage(pace, end.getTime(), end.getTime() + 12 * H);
  assert.ok(hourly < 0.1, `expected ~0, got ${hourly}`);
  assert.ok(pace.ratePerHour * 12 > 3.5, 'the flat average would have reserved ~4%');
});

test('activeHours "auto" resolves to the learned quiet hours', () => {
  const end = new Date(2026, 10, 26, 23, 0);
  const pace = userPace(workdayHistory(10, 1, end), end);
  const cfg = { ...DEFAULTS, activeHours: 'auto' };
  assert.equal(resolveActiveHours(cfg, pace), '17-9');
  assert.equal(resolveActiveHours(cfg, userPace([], end)), '', 'any time until it knows');
  assert.equal(shouldStart(usage(10, 100), cfg, new Date(2026, 10, 26, 12, 0), pace).start, false);
});

// ---------- shared rules ----------

test('waits for the 5-hour window', () => {
  assert.equal(shouldStart(usage(40, 10, 97), deadline, now).start, false);
});

test('no weekly limit (API key) never starts', () => {
  assert.equal(shouldStart({}, DEFAULTS, now).start, false);
});

test('stops at the cap and when the week rolls over', () => {
  const u = usage(50, 10);
  assert.equal(shouldStop(u, DEFAULTS, u.weekly.resetsAt, now), undefined);
  // sub-second jitter in resets_at is not a reset
  assert.equal(shouldStop(u, DEFAULTS, new Date(Date.parse(u.weekly.resetsAt) - 750).toISOString(), now), undefined);
  assert.match(shouldStop(usage(95, 10), DEFAULTS, inHours(10), now)!, /cap/);
  assert.match(shouldStop(usage(1, 168), DEFAULTS, inHours(10), now)!, /reset/);
});

test('active hours, including overnight ranges', () => {
  const at = (h: number) => new Date(2026, 10, 26, h, 30);
  assert.equal(inActiveHours('', at(14)), true);
  assert.equal(inActiveHours('22-7', at(23)), true);
  assert.equal(inActiveHours('22-7', at(3)), true);
  assert.equal(inActiveHours('22-7', at(14)), false);
  assert.equal(inActiveHours('9-17', at(14)), true);
  assert.equal(inActiveHours('9-17', at(18)), false);
  const cfg = { ...deadline, activeHours: '1-2' };
  assert.match(shouldStart(usage(40, 10), cfg, at(14)).reason, /hours Replenish runs in/);
});

// ---------- plumbing ----------

test('parses the Claude Code get_usage response', () => {
  const u = parseUsage({
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 0, resets_at: '2026-11-25T00:29:59Z' },
      seven_day: { utilization: 8, resets_at: '2026-11-27T10:59:59Z' },
    },
  });
  assert.deepEqual(u, {
    plan: 'pro',
    weekly: { percentUsed: 8, resetsAt: '2026-11-27T10:59:59Z' },
    session: { percentUsed: 0, resetsAt: '2026-11-25T00:29:59Z' },
  });
  assert.deepEqual(parseUsage({ rate_limits_available: false, subscription_type: null }), { plan: undefined });
});

test('reads the agent status line', () => {
  assert.equal(parseStatus('All good.\nREPLENISH_STATUS: done'), 'done');
  assert.equal(parseStatus('REPLENISH_STATUS: Continue'), 'continue');
  assert.equal(parseStatus('no marker'), undefined);
});

test('finishes in-progress work before starting new projects', () => {
  const base = { brief: '', runs: [], createdAt: '2026-01-01' };
  const projects: Project[] = [
    { ...base, id: 'a', name: 'a', priority: 1, status: 'queued' },
    { ...base, id: 'b', name: 'b', priority: 5, status: 'in_progress' },
    { ...base, id: 'c', name: 'c', priority: 0, status: 'done' },
  ];
  assert.equal(nextProject(projects)?.id, 'b');
  assert.equal(nextProject(projects.slice(0, 1))?.id, 'a');
});
