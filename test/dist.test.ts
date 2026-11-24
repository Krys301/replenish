import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

/**
 * dist/ is committed so `npm install -g github:...` works without compiling on the user's machine
 * (npm can't run a build step for global git installs). This fails if someone changes src/ and
 * forgets `npm run compile`.
 */
test('committed dist/ matches a fresh build of src/', () => {
  const root = join(import.meta.dirname, '..');
  const out = mkdtempSync(join(tmpdir(), 'replenish-dist-'));
  try {
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', out]);
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const fresh = files(out).map((f) => relative(out, f)).sort();
    const committed = files(join(root, 'dist')).map((f) => relative(join(root, 'dist'), f)).sort();
    assert.deepEqual(committed, fresh, 'dist/ has different files than a fresh build. Run: npm run compile');
    for (const f of fresh) {
      const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      assert.equal(norm(join(root, 'dist', f)), norm(join(out, f)), `dist/${f} is stale. Run: npm run compile`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
