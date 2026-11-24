import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
/**
 * Set in every claude process Replenish starts. If anything inside that session (a hook, a
 * script, the agent itself) tries to run Replenish again, Replenish refuses, so a run can never
 * chain into more runs.
 */
export const CHILD_ENV = 'REPLENISH_CHILD';
export function resolveClaude(configured) {
    if (configured)
        return configured;
    const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    // Common install spots that cron/Task Scheduler PATHs often miss.
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin');
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = join(dir, name);
            if (existsSync(candidate))
                return candidate;
        }
    }
    throw new Error('Could not find the `claude` CLI. Install Claude Code, or set it with: replenish config claudePath <path>');
}
class StreamSession {
    proc;
    nextId = 0;
    pending = new Map();
    buffer = '';
    stderr = '';
    exited;
    onMessage = () => { };
    constructor(bin, args, cwd, log) {
        // npm installs of claude on Windows are .cmd shims, which need a shell. Our args contain no
        // quotes, so wrapping each in quotes is enough.
        const viaShell = /\.(cmd|bat)$/i.test(bin);
        const env = { ...process.env, [CHILD_ENV]: '1' };
        this.proc = viaShell
            ? spawn([bin, ...args].map((a) => `"${a}"`).join(' '), { cwd, env, shell: true, windowsHide: true })
            : spawn(bin, args, { cwd, env, windowsHide: true });
        this.proc.stdout.setEncoding('utf8').on('data', (chunk) => {
            log?.write(chunk);
            this.buffer += chunk;
            let nl;
            while ((nl = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, nl).trim();
                this.buffer = this.buffer.slice(nl + 1);
                if (line)
                    this.handle(line);
            }
        });
        this.proc.stderr.setEncoding('utf8').on('data', (chunk) => {
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
            for (const { reject } of this.pending.values())
                reject(new Error(`claude exited: ${this.lastError()}`));
            this.pending.clear();
        });
    }
    lastError() {
        return this.stderr.trim().split('\n').slice(-3).join(' ') || 'no output';
    }
    handle(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        if (msg.type === 'control_response') {
            const r = msg.response ?? {};
            const waiter = this.pending.get(r.request_id);
            if (!waiter)
                return;
            this.pending.delete(r.request_id);
            if (r.subtype === 'success')
                waiter.resolve(r.response ?? {});
            else
                waiter.reject(new Error(r.error ?? 'control request failed'));
            return;
        }
        if (msg.type === 'control_request') {
            // Nobody is around to approve anything: deny tool prompts, refuse everything else.
            const req = msg.request ?? {};
            const response = req.subtype === 'can_use_tool'
                ? { subtype: 'success', request_id: msg.request_id, response: { behavior: 'deny', message: 'Replenish runs unattended; no one can approve this. Find another way or note it in REPLENISH.md.' } }
                : { subtype: 'error', request_id: msg.request_id, error: 'Not supported by Replenish' };
            this.send({ type: 'control_response', response });
            return;
        }
        this.onMessage(msg);
    }
    send(obj) {
        if (this.proc.stdin?.writable)
            this.proc.stdin.write(JSON.stringify(obj) + '\n');
    }
    request(subtype, extra = {}, timeoutMs = 30_000) {
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
    sendUserMessage(text) {
        this.send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
    }
    kill() {
        this.proc.kill();
    }
    async close(graceMs = 5000) {
        this.proc.stdin?.end();
        const timer = setTimeout(() => this.proc.kill(), graceMs);
        await this.exited;
        clearTimeout(timer);
    }
}
/** Turn a Claude Code tool call into a few words for the progress line. */
export function describeToolUse(name, input = {}) {
    const file = typeof input.file_path === 'string' ? basename(input.file_path) : typeof input.notebook_path === 'string' ? basename(input.notebook_path) : '';
    switch (name) {
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
            return `Editing ${file}`;
        case 'Write':
            return `Writing ${file}`;
        case 'Read':
            return `Reading ${file}`;
        case 'Bash':
        case 'PowerShell': {
            const cmd = String(input.description || input.command || '').replace(/\s+/g, ' ').trim();
            return `Running: ${cmd.length > 60 ? cmd.slice(0, 59) + '…' : cmd}`;
        }
        case 'Glob':
        case 'Grep':
            return 'Searching the code';
        case 'WebSearch':
        case 'WebFetch':
            return 'Researching online';
        case 'Agent':
        case 'Task':
            return 'Working with a subagent';
        case 'TodoWrite':
            return 'Planning';
        default:
            return `Using ${name}`;
    }
}
const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
function toWindow(w) {
    if (!w || typeof w.utilization !== 'number' || !w.resets_at)
        return undefined;
    return { percentUsed: w.utilization, resetsAt: w.resets_at };
}
export function parseUsage(res) {
    if (res.rate_limits_available === false || !res.rate_limits)
        return { plan: res.subscription_type ?? undefined };
    const rl = res.rate_limits;
    return { plan: res.subscription_type ?? undefined, weekly: toWindow(rl.seven_day), session: toWindow(rl.five_hour) };
}
export class ClaudeProvider {
    id = 'claude';
    displayName = 'Claude Code';
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    bin() {
        return resolveClaude(this.opts.bin);
    }
    async getUsage() {
        mkdirSync(this.opts.scratchDir, { recursive: true });
        // Safe mode + no persistence: no hooks/MCP start up and nothing lands in the user's /resume list.
        const s = new StreamSession(this.bin(), [...STREAM_ARGS, '--safe-mode', '--no-session-persistence'], this.opts.scratchDir);
        try {
            await s.request('initialize');
            return parseUsage(await s.request('get_usage', { skip_behaviors: true }));
        }
        finally {
            await s.close(2000);
        }
    }
    startJob(job) {
        mkdirSync(dirname(job.logFile), { recursive: true });
        const base = job.logFile.replace(/\.jsonl$/, '');
        const promptFile = `${base}.system.md`;
        writeFileSync(promptFile, job.systemPrompt);
        // Hooks are switched off in unattended sessions: a user hook that itself runs `claude -p`
        // (e.g. on SessionEnd) would otherwise fire on every round and can chain-spawn sessions.
        const settingsFile = `${base}.settings.json`;
        writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true }));
        const args = [
            ...STREAM_ARGS,
            '--permission-mode', this.opts.permissionMode,
            '--append-system-prompt-file', promptFile,
            '--settings', settingsFile,
            '--name', 'replenish',
        ];
        if (this.opts.model)
            args.push('--model', this.opts.model);
        if (job.resumeSessionId)
            args.push('--resume', job.resumeSessionId);
        const log = createWriteStream(job.logFile, { flags: 'a' });
        const s = new StreamSession(this.bin(), args, job.cwd, log);
        let sessionId = job.resumeSessionId;
        let interrupted = false;
        let result;
        let finish;
        const gotResult = new Promise((r) => (finish = r));
        s.onMessage = (msg) => {
            if (msg.session_id)
                sessionId = msg.session_id;
            if (job.onActivity && msg.type === 'assistant' && !msg.parent_tool_use_id && Array.isArray(msg.message?.content)) {
                for (const block of msg.message.content) {
                    if (block.type === 'tool_use')
                        job.onActivity(describeToolUse(block.name, block.input));
                    else if (block.type === 'text' && block.text?.trim())
                        job.onActivity('Thinking…');
                }
            }
            if (msg.type === 'result') {
                result = msg;
                finish();
            }
        };
        const done = (async () => {
            try {
                await s.request('initialize', {}, 60_000);
                s.sendUserMessage(job.prompt);
                await Promise.race([gotResult, s.exited]);
            }
            catch (err) {
                await s.close(2000);
                log.end();
                return { sessionId, isError: true, interrupted, error: err.message };
            }
            await s.close();
            log.end();
            if (!result)
                return { sessionId, isError: true, interrupted, error: `claude exited without a result: ${s.lastError()}` };
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
                await s.request('interrupt', {}, 15_000).catch(() => { });
            },
            kill: () => {
                interrupted = true;
                s.kill();
            },
        };
    }
}
