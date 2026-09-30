import { describe, expect, it } from 'vitest';
import ignoreFactory, { type Ignore } from 'ignore';
import { AthenaConfig } from '../../src/core/config.js';
import { IgnoreMatcher } from '../../src/core/fs/ignore.js';

const GITIGNORES: Record<string, string> = {
  '': '*.log\n!keep.log\nbuild/\n/root-only.txt\n',
  packages: 'generated/\n*.tmp\n',
  'packages/a': 'secret.txt\n!*.tmp\nnested/deep/\n',
  'packages/a/src': '*.snap\n!important.snap\n',
  'packages/b': '/release\n',
  'weird.dir': '*\n!*.md\n',
};

function matcher(): IgnoreMatcher {
  const m = new IgnoreMatcher(AthenaConfig.parse({ ignore: ['tmp/'], include: ['build/keep.js'] }));
  for (const [dir, content] of Object.entries(GITIGNORES)) m.setGitignore(dir, content);
  return m;
}

/** The 0.2.1 algorithm: consult every registered .gitignore, in registration order. */
function legacyIgnores(rel: string, isDir: boolean): boolean {
  const cfg = AthenaConfig.parse({ ignore: ['tmp/'], include: ['build/keep.js'] });
  const m = new IgnoreMatcher(cfg); // for base/include only
  if (!rel || rel === '.') return false;
  const test = isDir ? `${rel}/` : rel;
  const inc = ignoreFactory().add(cfg.include);
  if (inc.ignores(test)) return false;
  if (m.ignores(rel, isDir)) {
    // base rules (no scoped files registered on this instance)
    return true;
  }
  const scoped = new Map<string, Ignore>(Object.entries(GITIGNORES).map(([d, c]) => [d, ignoreFactory().add(c)]));
  for (const [dir, ig] of scoped) {
    if (dir === '') {
      if (ig.ignores(test)) return true;
    } else if (rel.startsWith(`${dir}/`)) {
      const sub = rel.slice(dir.length + 1);
      if (ig.ignores(isDir ? `${sub}/` : sub)) return true;
    }
  }
  return false;
}

describe('IgnoreMatcher with nested .gitignore files', () => {
  it('applies each .gitignore only below its own directory, with negations', () => {
    const m = matcher();
    expect(m.ignores('app.log')).toBe(true);
    expect(m.ignores('keep.log')).toBe(false);
    expect(m.ignores('packages/a/keep.log')).toBe(false);
    expect(m.ignores('root-only.txt')).toBe(true);
    expect(m.ignores('packages/root-only.txt')).toBe(false); // anchored to the root .gitignore
    expect(m.ignores('packages/x.tmp')).toBe(true);
    // A negation in a deeper .gitignore does not un-ignore what an ancestor ignores
    // (Athena treats nested rules as additive).
    expect(m.ignores('packages/a/x.tmp')).toBe(true);
    expect(m.ignores('packages/a/secret.txt')).toBe(true);
    expect(m.ignores('packages/b/secret.txt')).toBe(false);
    expect(m.ignores('packages/a/src/x.snap')).toBe(true);
    expect(m.ignores('packages/a/src/important.snap')).toBe(false);
    expect(m.ignores('packages/a/nested/deep', true)).toBe(true);
    expect(m.ignores('packages/a/nested/deep', false)).toBe(false);
    expect(m.ignores('packages/b/release', true)).toBe(true);
    expect(m.ignores('packages/b/src/release', true)).toBe(false); // "/release" is anchored to packages/b
    expect(m.ignores('weird.dir/a.ts')).toBe(true);
    expect(m.ignores('weird.dir/a.md')).toBe(false);
    expect(m.ignores('weird.dirx/a.ts')).toBe(false); // prefix of a name is not an ancestor
    expect(m.ignores('build/keep.js')).toBe(false); // include wins
    expect(m.ignores('tmp', true)).toBe(true);
  });

  it('honors removal and replacement of a nested .gitignore', () => {
    const m = matcher();
    expect(m.ignores('packages/a/secret.txt')).toBe(true);
    m.setGitignore('packages/a', 'other.txt\n');
    expect(m.ignores('packages/a/secret.txt')).toBe(false);
    expect(m.ignores('packages/a/other.txt')).toBe(true);
    m.removeGitignore('packages/a');
    expect(m.ignores('packages/a/other.txt')).toBe(false);
    m.setGitignore('packages/a', 'more.txt\n', true);
    expect(m.ignores('packages/a/more.txt')).toBe(true);
  });

  it('matches the previous all-scopes scan on many paths', () => {
    const m = matcher();
    const segs = ['packages', 'a', 'b', 'src', 'generated', 'nested', 'deep', 'release', 'dist', 'weird.dir', 'build', 'tmp'];
    const leaves = ['x.ts', 'app.log', 'keep.log', 'secret.txt', 'x.tmp', 'x.snap', 'important.snap', 'a.md', 'root-only.txt'];
    let checked = 0;
    for (let seed = 1; seed < 800; seed++) {
      let s = seed;
      const next = (n: number) => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s % n;
      };
      const depth = next(5);
      const parts = Array.from({ length: depth }, () => segs[next(segs.length)]!);
      const isDir = next(3) === 0;
      const rel = [...parts, ...(isDir && parts.length ? [] : [leaves[next(leaves.length)]!])].join('/');
      expect(m.ignores(rel, isDir), `${rel} dir=${isDir}`).toBe(legacyIgnores(rel, isDir));
      checked++;
    }
    expect(checked).toBeGreaterThan(700);
  });

  it('stays fast with thousands of nested .gitignore files', () => {
    const m = new IgnoreMatcher(AthenaConfig.parse({}));
    for (let i = 0; i < 5000; i++) m.setGitignore(`pkgs/p${i}`, '*.gen\n');
    const t = performance.now();
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (m.ignores(`pkgs/p${i % 5000}/src/file${i}.gen`)) hits++;
    expect(hits).toBe(20_000);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
