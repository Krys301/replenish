import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, type Config } from './config.ts';
import { loadSamples, recordSample, userPace, type UserPace } from './history.ts';
import { shouldStart, shouldStop } from './policy.ts';
import { printLine, Progress } from './progress.ts';
import { resultSummary } from './results.ts';
import { CHILD_ENV, ClaudeProvider } from './providers/claude.ts';
import type { JobResult, Provider, Usage } from './providers/types.ts';
import { loadQueue, nextProject, updateProject, type Project, type RunRecord } from './store.ts';

export function log(msg: string) {
  printLine(`[${new Date().toISOString()}] ${msg}`);
}

export function makeProvider(cfg: Config): Provider {
  return new ClaudeProvider({ bin: cfg.claudePath, model: cfg.model, permissionMode: cfg.permissionMode, scratchDir: join(PATHS.logs, 'probe') });
}

export const SYSTEM_PROMPT = `You are running unattended inside Replenish, which spends the user's leftover AI plan usage on projects they queued but never got around to building.

No human is watching. Nobody can answer questions or approve anything, so:
- Make sensible decisions yourself and write them down instead of asking.
- Work only inside the current directory. Never push, deploy, publish packages, send messages, spend money, or create accounts.
- Your session can be cut off at any moment when the usage limit is reached. Commit to git after every meaningful step, with clear messages, so no work is lost.
- Keep REPLENISH.md in the project root up to date: a one-paragraph summary, what's done, decisions you made, how to run it, and the next steps. A later session (maybe you, maybe the user) picks up from that file.
- Aim for something the user can actually run and try, then improve it. Prefer simple, mainstream tools.

End your final message with exactly one of these lines:
REPLENISH_STATUS: done      (the brief is built and working)
REPLENISH_STATUS: continue  (more work remains and you could keep going)
REPLENISH_STATUS: blocked   (you cannot go further without the user, explain why in REPLENISH.md)`;

const firstPrompt = (p: Project) =>
  `Build this project. It was queued by the user for Replenish.\n\nProject: ${p.name}\n\nBrief:\n${p.brief}\n\nStart by writing a short plan in REPLENISH.md, then build it.`;

const RESUME_PROMPT = 'Continue the project from where you left off. Check REPLENISH.md and `git log` for progress, then keep building.';

export function parseStatus(text: string | undefined): 'done' | 'continue' | 'blocked' | undefined {
  const m = text?.match(/REPLENISH_STATUS:\s*(done|continue|blocked)/i);
  return m?.[1]?.toLowerCase() as 'done' | 'continue' | 'blocked' | undefined;
}

// ---------- locking: only one Replenish run at a time ----------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireLock(): boolean {
  mkdirSync(PATHS.logs, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(PATHS.lock, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return true;
    } catch {
      try {
        const { pid } = JSON.parse(readFileSync(PATHS.lock, 'utf8'));
        if (isAlive(pid)) return false;
      } catch {
        /* unreadable lock: treat as stale */
      }
      rmSync(PATHS.lock, { force: true });
    }
  }
  return false;
}

/** True while a Replenish run holds the lock (its usage would pollute an "idle" sample). */
export function runInProgress(): boolean {
  try {
    return isAlive(JSON.parse(readFileSync(PATHS.lock, 'utf8')).pid);
  } catch {
    return false;
  }
}

function releaseLock() {
  rmSync(PATHS.lock, { force: true });
}

// ---------- workspace ----------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function prepareWorkDir(p: Project, cfg: Config): string {
  if (p.workDir && existsSync(p.workDir)) return p.workDir;
  const dir = join(cfg.projectsDir, p.id);
  if (p.repo) {
    // Work on a separate worktree + branch so the user's checkout is never touched.
    git(p.repo, 'worktree', 'add', dir, '-b', `replenish/${p.id}`);
  } else {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, '.git'))) git(dir, 'init', '-q');
  }
  updateProject(p.id, { workDir: dir });
  return dir;
}

// ---------- one project ----------

const MAX_ROUNDS_PER_RUN = 10;

interface RunOutcome {
  record: RunRecord;
  /** Should the tick move on to another project? */
  keepGoing: boolean;
  /** Set when Replenish stopped the run (limits, kill switch, watchdog...). */
  stopReason?: string;
}

/** Give an interrupted agent this long to wind down before killing it. */
const KILL_GRACE_MS = 90_000;
/** Stop rather than run blind after this many failed usage checks in a row. */
const MAX_FAILED_USAGE_CHECKS = 3;

async function runProject(
  p: Project,
  provider: Provider,
  cfg: Config,
  weekResetAt: string,
  weeklyBefore: number,
  pace: UserPace | undefined,
): Promise<RunOutcome> {
  const startedAt = new Date();
  const workDir = prepareWorkDir(p, cfg);
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  updateProject(p.id, { status: 'in_progress' });
  log(`Working on "${p.name}" in ${workDir}`);

  let sessionId = p.sessionId;
  let stopReason: string | undefined;
  let lastResult: JobResult | undefined;
  let status: ReturnType<typeof parseStatus>;
  let cost = 0;
  let consecutiveErrors = 0;
  const progress = new Progress(workDir, weeklyBefore);
  progress.begin();

  for (let round = 1; round <= MAX_ROUNDS_PER_RUN && !stopReason; round++) {
    progress.setActivity(sessionId ? 'Resuming where it left off…' : 'Starting Claude…');
    const job = provider.startJob({
      cwd: workDir,
      prompt: sessionId ? RESUME_PROMPT : firstPrompt(p),
      systemPrompt: SYSTEM_PROMPT,
      resumeSessionId: sessionId,
      logFile: join(PATHS.logs, p.id, `${stamp}-r${round}.jsonl`),
      onActivity: (text) => progress.setActivity(text),
    });

    let killTimer: NodeJS.Timeout | undefined;
    const stopJob = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      log(`Stopping: ${reason}`);
      void job.interrupt();
      // A hung tool can ignore the interrupt; don't let it hold the lock forever.
      killTimer = setTimeout(() => {
        log('The session ignored the interrupt; killing it.');
        job.kill();
      }, KILL_GRACE_MS);
    };
    const onSignal = () => stopJob('Replenish was shut down.');
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const watchdog = setTimeout(
      () => stopJob(`The session ran longer than ${cfg.maxRunMinutes} min (watchdog); will resume next time.`),
      cfg.maxRunMinutes * 60_000,
    );

    let failedChecks = 0;
    const timer = setInterval(async () => {
      if (existsSync(PATHS.stop)) return stopJob('Replenish is paused (kill switch).');
      try {
        const live = await job.getUsage();
        progress.weeklyNow = live.weekly?.percentUsed;
        const reason = shouldStop(live, cfg, weekResetAt, new Date(), pace);
        failedChecks = 0;
        if (reason) stopJob(reason);
      } catch (err) {
        failedChecks++;
        log(`Usage check failed (${failedChecks}/${MAX_FAILED_USAGE_CHECKS}): ${(err as Error).message}`);
        if (failedChecks >= MAX_FAILED_USAGE_CHECKS) stopJob("Couldn't read usage; stopping rather than running blind.");
      }
    }, cfg.checkIntervalSeconds * 1000);

    lastResult = await job.done;
    clearInterval(timer);
    clearTimeout(watchdog);
    clearTimeout(killTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);

    cost += lastResult.costUsd ?? 0;
    if (lastResult.sessionId) {
      sessionId = lastResult.sessionId;
      updateProject(p.id, { sessionId });
    }

    if (lastResult.isError) {
      consecutiveErrors++;
      log(`Round ${round} errored: ${lastResult.error}`);
      // A broken resume (e.g. transcript deleted) shouldn't wedge the project: start fresh next time.
      if (consecutiveErrors === 1 && sessionId && !lastResult.finalText) {
        sessionId = undefined;
        updateProject(p.id, { sessionId: undefined });
        continue;
      }
      break;
    }
    consecutiveErrors = 0;
    status = parseStatus(lastResult.finalText);
    if (status === 'done' || status === 'blocked') break;
  }

  progress.end();
  let outcome: RunRecord['outcome'];
  let reason: string;
  if (status === 'done') [outcome, reason] = ['done', 'Agent reports the project is built.'];
  else if (status === 'blocked') [outcome, reason] = ['blocked', 'Agent needs you; see REPLENISH.md.'];
  else if (stopReason) [outcome, reason] = ['paused', stopReason];
  else if (lastResult?.isError) {
    const failures = [...p.runs.slice(-2), { outcome: 'failed' }].filter((r) => r.outcome === 'failed').length;
    outcome = failures >= 3 ? 'failed' : 'paused';
    reason = `Error: ${lastResult.error}`;
  } else [outcome, reason] = ['paused', `Reached ${MAX_ROUNDS_PER_RUN} rounds this run; will continue next time.`];

  let weeklyAfter: number | undefined;
  try {
    const after = await provider.getUsage();
    recordSample(after, 'run-end');
    weeklyAfter = after.weekly?.percentUsed;
  } catch {
    /* non-fatal */
  }

  const report = writeReport(p, workDir, { outcome, reason, startedAt, weeklyBefore, weeklyAfter, cost, finalText: lastResult?.finalText });
  const record: RunRecord = {
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    outcome,
    reason,
    weeklyBefore,
    weeklyAfter,
    costUsd: cost || undefined,
    report,
  };
  const fresh = loadQueue().find((x) => x.id === p.id) ?? p;
  const nextStatus = outcome === 'paused' ? 'in_progress' : outcome;
  updateProject(p.id, { status: nextStatus, runs: [...fresh.runs, record] });
  log(`"${p.name}": ${outcome} (${reason})`);
  // Tell the person exactly where their project is and how to open it.
  printLine(resultSummary(loadQueue().find((x) => x.id === p.id) ?? p));

  // Only move on to another project if this one ended for its own reasons, not because of limits.
  return { record, keepGoing: !stopReason && outcome !== 'paused', stopReason };
}

function writeReport(
  p: Project,
  workDir: string,
  r: { outcome: string; reason: string; startedAt: Date; weeklyBefore: number; weeklyAfter?: number; cost: number; finalText?: string },
): string {
  let commits = '';
  try {
    commits = git(workDir, 'log', '--oneline', '-n', '30');
  } catch {
    commits = '(no commits yet)';
  }
  const mins = Math.round((Date.now() - r.startedAt.getTime()) / 60000);
  const md = `# ${p.name}: ${r.outcome}

- **When:** ${r.startedAt.toLocaleString()} (${mins} min)
- **Why it stopped:** ${r.reason}
- **Weekly usage:** ${r.weeklyBefore}% → ${r.weeklyAfter ?? '?'}%
- **Folder:** ${workDir}${p.repo ? `\n- **Branch:** replenish/${p.id} (in ${p.repo})` : ''}

## Claude's last message

${(r.finalText ?? '(none)').trim()}

## Commits

\`\`\`
${commits || '(no commits yet)'}
\`\`\`
`;
  mkdirSync(PATHS.reports, { recursive: true });
  const file = join(PATHS.reports, `${r.startedAt.toISOString().slice(0, 16).replace(/[T:]/g, '-')}-${p.id}.md`);
  writeFileSync(file, md);
  return file;
}

// ---------- the scheduled tick ----------

export interface TickOptions {
  /** Ignore the "close to reset" window (still respects the usage cap). */
  force?: boolean;
  dryRun?: boolean;
  projectId?: string;
}

/** Longest Replenish will wait inside a run for the 5-hour window to reset. */
const MAX_SESSION_WAIT_MS = 90 * 60_000;

/**
 * If only the 5-hour limit is in the way (the weekly spare isn't used yet) and it resets soon,
 * how long to wait for it. Waiting beats ending the run: the hourly check could otherwise lose
 * up to an hour of every 5-hour window, which adds up to a lot of unused spare by the reset.
 */
function sessionWaitMs(usage: Usage, cfg: Config, weekResetAt: string, pace: UserPace | undefined): number | undefined {
  const { session } = usage;
  if (!session || session.percentUsed < cfg.stopAtPercent) return undefined;
  if (shouldStop({ ...usage, session: undefined }, cfg, weekResetAt, new Date(), pace)) return undefined;
  const wait = Date.parse(session.resetsAt) - Date.now() + 60_000;
  return wait > 0 && wait <= MAX_SESSION_WAIT_MS ? wait : undefined;
}

async function sleepUnlessPaused(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(PATHS.stop)) return false;
    await new Promise((r) => setTimeout(r, Math.min(30_000, end - Date.now())));
  }
  return !existsSync(PATHS.stop);
}

export async function tick(cfg: Config, opts: TickOptions = {}): Promise<void> {
  // Never let a Replenish-started session (its hooks, scripts, or the agent itself) start more runs.
  if (process.env[CHILD_ENV]) {
    log('Refusing to run: this was started from inside a Replenish session.');
    return;
  }
  if (existsSync(PATHS.stop)) {
    log('Replenish is paused (kill switch). Run `replenish resume` to re-enable.');
    return;
  }
  const provider = makeProvider(cfg);
  if (!acquireLock()) {
    log('Another Replenish run is in progress; skipping.');
    return;
  }
  try {
    let usage = await provider.getUsage();
    recordSample(usage, 'idle');
    // A manual `run` is the person's call: it only respects the hard cap, not the pace forecast.
    const pace = opts.force ? undefined : userPace(loadSamples());
    const decision = shouldStart(usage, cfg, new Date(), pace);
    if (!decision.start) {
      // `run` overrides the waiting rules, but never the hard limits (cap, 5-hour limit, reset).
      const hardStop = usage.weekly ? shouldStop(usage, cfg, usage.weekly.resetsAt, new Date()) : decision.reason;
      if (!opts.force || hardStop) {
        log(opts.force ? `Can't start: ${hardStop}` : decision.reason);
        return;
      }
      log(`Starting now because you ran \`replenish run\`. (Left alone, Replenish would wait: ${decision.reason})`);
    } else {
      log(decision.reason);
    }

    const weekResetAt = usage.weekly!.resetsAt;
    for (;;) {
      const queue = loadQueue();
      const project = opts.projectId ? queue.find((p) => p.id === opts.projectId) : nextProject(queue);
      if (!project) {
        log(opts.projectId ? `No project "${opts.projectId}".` : 'Queue is empty. Add ideas with: replenish add "..."');
        return;
      }
      if (project.status !== 'queued' && project.status !== 'in_progress') {
        log(`"${project.name}" is ${project.status}. Use \`replenish requeue ${project.id}\` to work on it again.`);
        return;
      }
      if (opts.dryRun) {
        log(`Dry run: would work on "${project.name}" (${project.id}).`);
        return;
      }
      const { keepGoing } = await runProject(project, provider, cfg, weekResetAt, usage.weekly!.percentUsed, pace);
      if (existsSync(PATHS.stop)) return;

      usage = await provider.getUsage();
      const stop = shouldStop(usage, cfg, weekResetAt, new Date(), pace);
      if (stop) {
        const wait = sessionWaitMs(usage, cfg, weekResetAt, pace);
        if (wait === undefined) {
          log(stop);
          return;
        }
        log(`5-hour limit is used up but weekly spare remains; waiting ${Math.round(wait / 60_000)} min for it to reset.`);
        if (!(await sleepUnlessPaused(wait))) return;
        usage = await provider.getUsage();
        continue; // resumes the same in-progress project first
      }
      if (!keepGoing || opts.projectId) return;
    }
  } finally {
    releaseLock();
  }
}
