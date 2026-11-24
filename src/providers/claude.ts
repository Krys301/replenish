import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { Job, JobOptions, JobResult, Provider, Usage, UsageWindow } from './types.ts';

/**
 * Talks to the user's own installed `claude` CLI over its stream-json protocol, so the user's
 * own login is used and Replenish never touches credentials.
 *
 * Usage comes from the CLI's `get_usage` control request: the same data `/usage` shows, read
 * without calling the model, so checking usage costs nothing.
 */

type Json = Record<string, any>;

export function resolveClaude(configured?: string): string {
  if (configured) return configured;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  // Common install spots that cron/Task Scheduler PATHs often miss.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Could not find the `claude` CLI. Install Claude Code, or set it with: replenish config claudePath <path>');
}

class StreamSession {
  private proc: ChildProcess;
  private nextId = 0;
  private pending = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private stderr = '';
  readonly exited: Promise<number | null>;
  onMessage: (msg: Json) => void = () => {};

  constructor(bin: string, args: string[], cwd: string, log?: NodeJS.WritableStream) {
    // npm installs of claude on Windows are .cmd shims, which need a shell. Our args contain no
    // quotes, so wrapping each in quotes is enough.
    const viaShell = /\.(cmd|bat)$/i.test(bin);
    this.proc = viaShell
      ? spawn([bin, ...args].map((a) => `"${a}"`).join(' '), { cwd, shell: true, windowsHide: true })
      : spawn(bin, args, { cwd, windowsHide: true });

    this.proc.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      log?.write(chunk);
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.handle(line);
      }
    });
    this.proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.exited = new Promise((resolve) => {
      this.proc.on('error', (err) => {
        this.stderr += String(err);
        resolve(null);
      });
      this.proc.on('exit', (code) => resolve(code));
    });
    this.exited.then(() => {
      for (const { reject } of this.pending.values()) reject(new Error(`claude exited: ${this.lastError()}`));
      this.pending.clear();
    });
  }

  lastError(): string {
    return this.stderr.trim().split('\n').slice(-3).join(' ') || 'no output';
  }

  private handle(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'control_response') {
      const r = msg.response ?? {};
      const waiter = this.pending.get(r.request_id);
      if (!waiter) return;
      this.pending.delete(r.request_id);
      if (r.subtype === 'success') waiter.resolve(r.response ?? {});
      else waiter.reject(new Error(r.error ?? 'control request failed'));
      return;
    }
    if (msg.type === 'control_request') {
      // Nobody is around to approve anything: deny tool prompts, refuse everything else.
      const req = msg.request ?? {};
      const response =
        req.subtype === 'can_use_tool'
          ? { subtype: 'success', request_id: msg.request_id, response: { behavior: 'deny', message: 'Replenish runs unattended; no one can approve this. Find another way or note it in REPLENISH.md.' } }
          : { subtype: 'error', request_id: msg.request_id, error: 'Not supported by Replenish' };
      this.send({ type: 'control_response', response });
      return;
    }
    this.onMessage(msg);
  }

  send(obj: unknown) {
    if (this.proc.stdin?.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(subtype: string, extra: Json = {}, timeoutMs = 30_000): Promise<Json> {
    const request_id = `rp-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`${subtype} timed out`));
      }, timeoutMs);
      this.pending.set(request_id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ type: 'control_request', request_id, request: { subtype, ...extra } });
    });
  }

  sendUserMessage(text: string) {
    this.send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  async close(graceMs = 5000) {
    this.proc.stdin?.end();
    const timer = setTimeout(() => this.proc.kill(), graceMs);
    await this.exited;
    clearTimeout(timer);
  }
}

const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

function toWindow(w: Json | null | undefined): UsageWindow | undefined {
  if (!w || typeof w.utilization !== 'number' || !w.resets_at) return undefined;
  return { percentUsed: w.utilization, resetsAt: w.resets_at };
}

export function parseUsage(res: Json): Usage {
  if (res.rate_limits_available === false || !res.rate_limits) return { plan: res.subscription_type ?? undefined };
  const rl = res.rate_limits;
  return { plan: res.subscription_type ?? undefined, weekly: toWindow(rl.seven_day), session: toWindow(rl.five_hour) };
}

export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  private opts: { bin?: string; model?: string; permissionMode: string; scratchDir: string };
  constructor(opts: ClaudeProvider['opts']) {
    this.opts = opts;
  }

  private bin() {
    return resolveClaude(this.opts.bin);
  }

  async getUsage(): Promise<Usage> {
    mkdirSync(this.opts.scratchDir, { recursive: true });
    // Safe mode + no persistence: no hooks/MCP start up and nothing lands in the user's /resume list.
    const s = new StreamSession(this.bin(), [...STREAM_ARGS, '--safe-mode', '--no-session-persistence'], this.opts.scratchDir);
    try {
      await s.request('initialize');
      return parseUsage(await s.request('get_usage', { skip_behaviors: true }));
    } finally {
      await s.close(2000);
    }
  }

  startJob(job: JobOptions): Job {
    mkdirSync(dirname(job.logFile), { recursive: true });
    const promptFile = job.logFile.replace(/\.jsonl$/, '') + '.system.md';
    writeFileSync(promptFile, job.systemPrompt);

    const args = [...STREAM_ARGS, '--permission-mode', this.opts.permissionMode, '--append-system-prompt-file', promptFile, '--name', 'replenish'];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (job.resumeSessionId) args.push('--resume', job.resumeSessionId);

    const log = createWriteStream(job.logFile, { flags: 'a' });
    const s = new StreamSession(this.bin(), args, job.cwd, log);

    let sessionId: string | undefined = job.resumeSessionId;
    let interrupted = false;
    let result: Json | undefined;
    let finish!: () => void;
    const gotResult = new Promise<void>((r) => (finish = r));

    s.onMessage = (msg) => {
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.type === 'result') {
        result = msg;
        finish();
      }
    };

    const done = (async (): Promise<JobResult> => {
      try {
        await s.request('initialize', {}, 60_000);
        s.sendUserMessage(job.prompt);
        await Promise.race([gotResult, s.exited]);
      } catch (err) {
        await s.close(2000);
        log.end();
        return { sessionId, isError: true, interrupted, error: (err as Error).message };
      }
      await s.close();
      log.end();
      if (!result) return { sessionId, isError: true, interrupted, error: `claude exited without a result: ${s.lastError()}` };
      return {
        sessionId,
        finalText: typeof result.result === 'string' ? result.result : undefined,
        costUsd: result.total_cost_usd,
        isError: Boolean(result.is_error) && !interrupted,
        interrupted,
        error: result.is_error ? String(result.subtype ?? 'error') : undefined,
      };
    })();

    return {
      done,
      getUsage: async () => parseUsage(await s.request('get_usage', { skip_behaviors: true })),
      interrupt: async () => {
        interrupted = true;
        await s.request('interrupt').catch(() => {});
      },
    };
  }
}
