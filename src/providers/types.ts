/**
 * A provider is one AI subscription Replenish can spend (Claude Code today; Codex, Gemini later).
 * Each one answers: how much is used, when does it reset, and how do I run a job unattended?
 */

export interface UsageWindow {
  /** 0-100 */
  percentUsed: number;
  /** ISO timestamp */
  resetsAt: string;
}

export interface Usage {
  plan?: string;
  /** The weekly (or monthly) limit Replenish tries to use up before it resets. */
  weekly?: UsageWindow;
  /** A short rolling limit (Claude's 5-hour window) that can pause a run. */
  session?: UsageWindow;
}

export interface JobOptions {
  cwd: string;
  /** First message for a fresh job, or the "keep going" message when resuming. */
  prompt: string;
  /** Standing rules for unattended work. */
  systemPrompt: string;
  resumeSessionId?: string;
  /** Raw event log for the run. */
  logFile: string;
}

export interface JobResult {
  sessionId?: string;
  /** The agent's final message. */
  finalText?: string;
  costUsd?: number;
  isError: boolean;
  /** True when Replenish interrupted the job (limit cap, reset, shutdown). */
  interrupted: boolean;
  error?: string;
}

export interface Job {
  /** Live usage, read through the running job (no extra process). */
  getUsage(): Promise<Usage>;
  /** Ask the agent to stop as soon as possible. */
  interrupt(): Promise<void>;
  readonly done: Promise<JobResult>;
}

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  getUsage(): Promise<Usage>;
  startJob(opts: JobOptions): Job;
}
