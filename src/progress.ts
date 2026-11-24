import { execFileSync } from 'node:child_process';

/**
 * Live progress for a build.
 *
 * In a terminal: one line at the bottom that keeps updating, e.g.
 *   [/] 12m 05s · 3 commits · weekly 10% → 14% · Editing index.html
 * plus a permanent "✓ <commit message>" line each time Claude commits.
 *
 * When output goes to a log file (the scheduled task), there's no live line; new commits are
 * still written as lines so the log shows what happened.
 */

const FRAMES = ['-', '\\', '|', '/'];
let active: Progress | undefined;

/** Print a normal line without garbling the live progress line. */
export function printLine(line: string) {
  active?.clear();
  console.log(line);
  active?.render();
}

function gitLines(cwd: string, ...args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // no commits yet
  }
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${sec}s`;
}

export class Progress {
  activity = 'Starting Claude…';
  weeklyNow?: number;
  private readonly tty = Boolean(process.stdout.isTTY);
  private readonly started = Date.now();
  private readonly workDir: string;
  private readonly weeklyStart?: number;
  private knownCommits: number;
  private newCommits = 0;
  private frame = 0;
  private shown = false;
  private timer?: NodeJS.Timeout;
  private lastCommitCheck = 0;

  constructor(workDir: string, weeklyStart?: number) {
    this.workDir = workDir;
    this.weeklyStart = weeklyStart;
    this.weeklyNow = weeklyStart;
    this.knownCommits = this.countCommits();
  }

  begin() {
    active = this;
    this.timer = setInterval(() => (this.tty ? this.render() : this.checkCommits()), this.tty ? 1000 : 15_000);
    this.render();
  }

  end() {
    clearInterval(this.timer);
    this.checkCommits();
    this.clear();
    if (active === this) active = undefined;
  }

  setActivity(text: string) {
    this.activity = text;
  }

  clear() {
    if (this.tty && this.shown) process.stdout.write('\r\x1b[2K');
    this.shown = false;
  }

  render() {
    if (Date.now() - this.lastCommitCheck > 5000) this.checkCommits();
    if (!this.tty) return;
    const parts = [
      `[${FRAMES[this.frame++ % FRAMES.length]}] ${duration(Date.now() - this.started)}`,
      `${this.newCommits} commit${this.newCommits === 1 ? '' : 's'}`,
    ];
    if (this.weeklyStart !== undefined) parts.push(`weekly ${this.weeklyStart}% → ${this.weeklyNow ?? '?'}%`);
    parts.push(this.activity);
    const width = Math.max(20, (process.stdout.columns ?? 100) - 1);
    let line = parts.join(' · ');
    if (line.length > width) line = line.slice(0, width - 1) + '…';
    process.stdout.write('\r\x1b[2K' + line);
    this.shown = true;
  }

  private countCommits(): number {
    return Number(gitLines(this.workDir, 'rev-list', '--count', 'HEAD')[0] ?? 0);
  }

  /** Print any commits made since the last check, oldest first. */
  private checkCommits() {
    this.lastCommitCheck = Date.now();
    const count = this.countCommits();
    if (count <= this.knownCommits) return;
    const subjects = gitLines(this.workDir, 'log', '--format=%s', '-n', String(count - this.knownCommits)).reverse();
    this.newCommits += count - this.knownCommits;
    this.knownCommits = count;
    const wasShown = this.shown;
    this.clear();
    for (const s of subjects) console.log(`  ✓ ${s}`);
    if (wasShown) this.render();
  }
}
