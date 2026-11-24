import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

/**
 * Why a folder can't be used with `--repo`, in plain words, or undefined if it's fine.
 * Replenish builds on a new branch in a separate worktree, which needs an existing git repo
 * with at least one commit to branch from.
 */
export function repoProblem(path: string): string | undefined {
  if (!existsSync(path)) return `The folder ${path} doesn't exist. Check the --repo path.`;
  if (!statSync(path).isDirectory()) return `${path} is a file, not a folder.`;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    run('--version');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return "git isn't installed (or isn't on PATH). Install it from https://git-scm.com.";
  }
  try {
    if (run('rev-parse', '--is-inside-work-tree') !== 'true') throw new Error();
  } catch {
    return `${path} isn't a git repo. Run \`git init\` there and commit your files first, or leave out --repo to build in a fresh folder.`;
  }
  try {
    run('rev-parse', '--verify', 'HEAD');
  } catch {
    return `${path} has no commits yet, so Replenish can't branch from it. Commit your files first: cd "${path}"; git add -A; git commit -m "Initial commit"`;
  }
  return undefined;
}
