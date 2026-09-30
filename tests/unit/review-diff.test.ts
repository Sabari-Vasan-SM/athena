import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addedLines, scanAddedLines } from '../../src/services/review.js';
import { readTextInsideRoot } from '../../src/core/util/fs.js';
import { git, GitCommandError, gitOrThrow } from '../../src/core/git/git.js';
import { FAKE } from '../helpers.js';

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-review-unit-')));
  tmpDirs.push(d);
  return d;
}

const pemLines = FAKE.pem.split('\n');

describe('review diff parsing', () => {
  it('finds a private key spread over several added lines, at the line where it starts', () => {
    const patch = [
      'diff --git a/config/keys.ts b/config/keys.ts',
      'index 1111111..2222222 100644',
      '--- a/config/keys.ts',
      '+++ b/config/keys.ts',
      `@@ -1,2 +1,${2 + pemLines.length} @@`,
      ' export const a = 1;',
      ...pemLines.map((l) => `+${l}`),
      ' export const b = 2;',
    ].join('\n');
    const hits = scanAddedLines(addedLines(patch));
    expect(hits).toEqual([{ type: 'private-key', file: 'config/keys.ts', line: 2 }]);
    expect(JSON.stringify(hits)).not.toContain('MIIE');
  });

  it('does not join added lines separated by context or in different files', () => {
    const lines = [
      { file: 'a', line: 1, text: pemLines[0]! },
      { file: 'a', line: 3, text: pemLines.slice(1).join('\n') },
      { file: 'b', line: 4, text: 'x' },
    ];
    expect(scanAddedLines(lines)).toEqual([]);
  });

  it('reads added lines whose content starts with "++" (they look like a +++ header)', () => {
    const patch = ['diff --git a/n.txt b/n.txt', '--- a/n.txt', '+++ b/n.txt', '@@ -0,0 +1,2 @@', `+++ token ${FAKE.github}`, '+ok'].join('\n');
    const lines = addedLines(patch);
    expect(lines.map((l) => l.line)).toEqual([1, 2]);
    expect(lines.every((l) => l.file === 'n.txt')).toBe(true);
    expect(scanAddedLines(lines).map((h) => h.type)).toContain('github-token');
  });

  it('unquotes paths git quotes', () => {
    const patch = ['diff --git "a/sp ace\\tx" "b/sp ace\\tx"', '--- "a/sp ace\\tx"', '+++ "b/sp ace\\tx"', '@@ -0,0 +1 @@', '+x'].join('\n');
    expect(addedLines(patch)[0]!.file).toBe('sp ace\tx');
  });
});

describe('readTextInsideRoot', () => {
  it('reads files, refuses symlinks leaving the root, and caps size', async () => {
    const root = await tmp();
    const outside = await tmp();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    await fs.writeFile(path.join(root, 'a.txt'), 'hello');
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(2048));
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await fs.symlink(path.join(root, 'a.txt'), path.join(root, 'inner-link.txt'));

    expect(await readTextInsideRoot(root, 'a.txt', 1024)).toEqual({ ok: true, text: 'hello', bytes: 5 });
    expect(await readTextInsideRoot(root, 'link.txt', 1024)).toEqual({ ok: false, reason: 'outside-root' });
    expect(await readTextInsideRoot(root, 'inner-link.txt', 1024)).toMatchObject({ ok: true, text: 'hello' });
    expect(await readTextInsideRoot(root, 'big.txt', 1024)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await readTextInsideRoot(root, 'missing.txt', 1024)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('git runner', () => {
  it('reports failures with exit code and stderr, and gitOrThrow throws', async () => {
    const dir = await tmp();
    const r = await git(dir, ['rev-parse', '--verify', 'nope^{commit}']);
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a git repository|fatal/i);
    await expect(gitOrThrow(dir, ['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitCommandError);
  });

  it('stops and flags output larger than maxBytes instead of truncating silently', async () => {
    const r = await git(process.cwd(), ['--help'], { maxBytes: 16 });
    expect(r.ok).toBe(false);
    expect(r.overflow).toBe(true);
    await expect(gitOrThrow(process.cwd(), ['--help'], { maxBytes: 16 })).rejects.toThrow(/exceeded 16 bytes/);
  });

  it('stops when the signal aborts', async () => {
    const ac = new AbortController();
    ac.abort(new Error('Interrupted'));
    const r = await git(process.cwd(), ['--version'], { signal: ac.signal });
    expect(r).toMatchObject({ ok: false, aborted: true });
    await expect(gitOrThrow(process.cwd(), ['--version'], { signal: ac.signal })).rejects.toThrow('Interrupted');
  });
});
