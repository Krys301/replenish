import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './config.ts';

/**
 * Registers an hourly `replenish tick` with the OS scheduler. Hourly is plenty: usage only
 * matters near the weekly reset, and a tick that decides "not yet" costs no model usage.
 */

const TASK_NAME = 'Replenish';
const CRON_MARK = '# replenish-tick';

function tickCommand(): { node: string; script: string; logFile: string } {
  return { node: process.execPath, script: process.argv[1]!, logFile: join(HOME, 'replenish.log') };
}

export function install(): string {
  mkdirSync(HOME, { recursive: true });
  const { node, script, logFile } = tickCommand();

  if (process.platform === 'win32') {
    // A .vbs launcher runs the tick with no console window flashing up every hour.
    const launcher = join(HOME, 'tick.vbs');
    const cmd = `cmd /c ""${node}" "${script}" tick >> "${logFile}" 2>&1"`;
    writeFileSync(launcher, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, True\r\n`);
    execFileSync('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'HOURLY', '/TR', `wscript.exe "${launcher}"`], { stdio: 'pipe' });
    return `Windows Task Scheduler task "${TASK_NAME}" runs every hour.`;
  }

  // macOS + Linux: a crontab line. (cron has a minimal PATH, which is why we pin absolute paths.)
  const line = `17 * * * * "${node}" "${script}" tick >> "${logFile}" 2>&1 ${CRON_MARK}`;
  const current = readCrontab().filter((l) => !l.includes(CRON_MARK));
  execFileSync('crontab', ['-'], { input: [...current, line].join('\n') + '\n' });
  return 'cron job runs every hour (at :17).';
}

export function uninstall(): string {
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/F', '/TN', TASK_NAME], { stdio: 'pipe' });
      return 'Removed the scheduled task.';
    } catch {
      return 'No scheduled task to remove.';
    }
  }
  const lines = readCrontab();
  const kept = lines.filter((l) => !l.includes(CRON_MARK));
  if (kept.length === lines.length) return 'No cron job to remove.';
  execFileSync('crontab', ['-'], { input: kept.join('\n') + '\n' });
  return 'Removed the cron job.';
}

function readCrontab(): string[] {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter((l) => l.trim());
  } catch {
    return [];
  }
}
