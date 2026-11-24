import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.ts';
import { shouldStart, shouldStop } from '../src/policy.ts';
import { parseUsage } from '../src/providers/claude.ts';
import { parseStatus } from '../src/runner.ts';
import { nextProject, type Project } from '../src/store.ts';

const now = new Date('2026-11-26T12:00:00Z');
const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
const usage = (weekly: number, resetH: number, session = 0) => ({
  weekly: { percentUsed: weekly, resetsAt: inHours(resetH) },
  session: { percentUsed: session, resetsAt: inHours(2) },
});

test('waits when the weekly reset is far away', () => {
  const d = shouldStart(usage(10, 72), DEFAULTS, now);
  assert.equal(d.start, false);
  assert.match(d.reason, /72\.0h away/);
});

test('starts near the reset with plenty left', () => {
  assert.equal(shouldStart(usage(40, 10), DEFAULTS, now).start, true);
});

test('skips when little is left', () => {
  assert.equal(shouldStart(usage(93, 10), DEFAULTS, now).start, false);
});

test('waits for the 5-hour window', () => {
  assert.equal(shouldStart(usage(40, 10, 97), DEFAULTS, now).start, false);
});

test('no weekly limit (API key) never starts', () => {
  assert.equal(shouldStart({}, DEFAULTS, now).start, false);
});

test('stops at the cap and when the week rolls over', () => {
  const u = usage(50, 10);
  assert.equal(shouldStop(u, DEFAULTS, u.weekly.resetsAt), undefined);
  // sub-second jitter in resets_at is not a reset
  assert.equal(shouldStop(u, DEFAULTS, new Date(Date.parse(u.weekly.resetsAt) - 750).toISOString()), undefined);
  assert.match(shouldStop(usage(95, 10), DEFAULTS, inHours(10))!, /cap/);
  assert.match(shouldStop(usage(1, 168), DEFAULTS, inHours(10))!, /reset/);
});

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
