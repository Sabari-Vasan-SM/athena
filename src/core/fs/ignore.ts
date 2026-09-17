import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignoreFactory, { type Ignore } from 'ignore';
import { DEFAULT_IGNORES, type AthenaConfig } from '../config.js';

/**
 * Gitignore-compatible matcher shared by the walker and the watcher:
 * default ignores, `.git/info/exclude`, nested `.gitignore` files (scoped to
 * their directory), and `.athena/config.json` ignore/include patterns.
 *
 * Matching is synchronous so it can be used from file-watcher callbacks;
 * nested `.gitignore` files are registered as they are discovered.
 */
export class IgnoreMatcher {
  private readonly base: Ignore;
  private readonly include: Ignore | null;
  /** Directory (repo-relative POSIX, "" for root) → rules from its .gitignore. */
  private readonly scoped = new Map<string, Ignore>();

  constructor(config: AthenaConfig) {
    this.base = ignoreFactory().add(DEFAULT_IGNORES.map((d) => `${d}/`)).add(config.ignore);
    this.include = config.include.length ? ignoreFactory().add(config.include) : null;
  }

  static async load(root: string, config: AthenaConfig): Promise<IgnoreMatcher> {
    const m = new IgnoreMatcher(config);
    const exclude = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8').catch(() => null);
    if (exclude) m.setGitignore('', exclude);
    const rootGi = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => null);
    if (rootGi) m.setGitignore('', rootGi, true);
    return m;
  }

  /** Register (or replace) the rules of `<dir>/.gitignore`. `append` merges with existing rules for that dir. */
  setGitignore(dir: string, content: string, append = false): void {
    const existing = append ? this.scoped.get(dir) : undefined;
    this.scoped.set(dir, (existing ?? ignoreFactory()).add(content));
  }

  removeGitignore(dir: string): void {
    this.scoped.delete(dir);
  }

  /** Is the repo-relative POSIX path ignored? `isDir` enables directory-only patterns ("build/"). */
  ignores(rel: string, isDir = false): boolean {
    if (!rel || rel === '.') return false;
    const test = isDir ? `${rel}/` : rel;
    if (this.include?.ignores(test)) return false;
    if (this.base.ignores(test)) return true;
    for (const [dir, ig] of this.scoped) {
      if (dir === '') {
        if (ig.ignores(test)) return true;
      } else if (rel.startsWith(`${dir}/`)) {
        const sub = rel.slice(dir.length + 1);
        if (ig.ignores(isDir ? `${sub}/` : sub)) return true;
      }
    }
    return false;
  }
}
