import { promises as fs } from 'node:fs';
import path from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { loadConfig } from '../core/config.js';
import { IgnoreMatcher } from '../core/fs/ignore.js';
import { git } from '../core/git/git.js';
import { toPosix } from '../core/util/paths.js';
import { applySync, needsIndexRefreshOnly, planSync, type ApplyResult, type SyncPlan } from './sync.js';

export interface WatchEvent {
  type: 'changes' | 'planning' | 'plan' | 'applied' | 'refreshed' | 'git-head' | 'error' | 'ready';
  paths?: string[];
  plan?: SyncPlan;
  result?: ApplyResult;
  head?: { from: string | null; to: string | null };
  error?: Error;
}

export interface WatchOptions {
  /** Quiet period after the last change before planning (ms). */
  debounceMs?: number;
  /** Plan at the latest this long after the first change of a burst (ms). */
  maxWaitMs?: number;
  /** Apply plans automatically. Default: propose only. */
  autoApply?: boolean;
  onEvent: (e: WatchEvent) => void;
  signal?: AbortSignal;
}

export interface ProjectWatcher {
  /** Plan immediately (skipping the debounce). Resolves with the plan. */
  planNow(): Promise<SyncPlan | null>;
  latestPlan(): SyncPlan | null;
  close(): Promise<void>;
}

async function gitDir(root: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--absolute-git-dir']);
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Watches a project and turns bursts of file changes into sync plans.
 * By default it never writes knowledge documents; it only proposes. When no
 * document would change, it refreshes the file index silently (safe: state only).
 */
export async function watchProject(root: string, opts: WatchOptions): Promise<ProjectWatcher> {
  const debounceMs = opts.debounceMs ?? 1500;
  const maxWaitMs = opts.maxWaitMs ?? 10_000;
  const { config } = await loadConfig(root);
  const matcher = await IgnoreMatcher.load(root, config);
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let firstChangeAt = 0;
  let running: Promise<SyncPlan | null> | null = null;
  let rerun = false;
  let latest: SyncPlan | null = null;
  let closed = false;

  const toRel = (abs: string) => toPosix(path.relative(root, abs));

  const run = async (): Promise<SyncPlan | null> => {
    if (closed) return null;
    if (running) {
      rerun = true;
      return running;
    }
    const paths = [...pending];
    pending.clear();
    firstChangeAt = 0;
    running = (async () => {
      opts.onEvent({ type: 'planning', paths });
      try {
        const plan = await planSync(root, { signal: opts.signal });
        if (closed) return null;
        latest = plan;
        if (plan.upToDate) {
          latest = null;
          if (needsIndexRefreshOnly(plan)) {
            const result = await applySync(root, plan);
            opts.onEvent({ type: 'refreshed', plan, result });
          } else {
            opts.onEvent({ type: 'plan', plan });
          }
          return plan;
        }
        if (opts.autoApply && !plan.ignored) {
          const result = await applySync(root, plan);
          latest = null;
          opts.onEvent({ type: 'applied', plan, result });
          return plan;
        }
        opts.onEvent({ type: 'plan', plan });
        return plan;
      } catch (err) {
        if (!closed && !opts.signal?.aborted) opts.onEvent({ type: 'error', error: err as Error });
        return null;
      } finally {
        running = null;
        if (rerun && !closed) {
          rerun = false;
          schedule();
        }
      }
    })();
    return running;
  };

  const schedule = () => {
    if (closed) return;
    const now = Date.now();
    if (!firstChangeAt) firstChangeAt = now;
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, firstChangeAt + maxWaitMs - now));
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, wait);
  };

  const onPath = (abs: string) => {
    const rel = toRel(abs);
    if (!rel || rel.startsWith('..')) return;
    if (rel === '.gitignore' || rel.endsWith('/.gitignore')) {
      const dir = rel === '.gitignore' ? '' : rel.slice(0, -'/.gitignore'.length);
      void fs
        .readFile(abs, 'utf8')
        .then((text) => matcher.setGitignore(dir, text))
        .catch(() => matcher.removeGitignore(dir));
    }
    pending.add(rel);
    opts.onEvent({ type: 'changes', paths: [rel] });
    schedule();
  };

  const watcher: FSWatcher = chokidarWatch(root, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    ignored: (abs, stats) => {
      const rel = toRel(abs);
      if (!rel || rel === '.') return false;
      if (rel.startsWith('..')) return true;
      if (rel === '.git' || rel.startsWith('.git/')) return true;
      if (stats) return matcher.ignores(rel, stats.isDirectory());
      return matcher.ignores(rel, false) || matcher.ignores(rel, true);
    },
  });
  // Subscribe to 'ready' immediately: it can fire before any later await resolves.
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  watcher.on('add', onPath).on('change', onPath).on('unlink', onPath).on('addDir', onPath).on('unlinkDir', onPath);
  watcher.on('error', (err) => opts.onEvent({ type: 'error', error: err as Error }));

  // Git HEAD moves (commit, checkout, pull) are relevant even when the working tree is unchanged.
  let headWatcher: FSWatcher | null = null;
  const gd = await gitDir(root);
  let lastHead: string | null = null;
  if (gd) {
    lastHead = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim() || null;
    headWatcher = chokidarWatch([path.join(gd, 'HEAD'), path.join(gd, 'refs', 'heads')], { ignoreInitial: true, persistent: true, depth: 5 });
    headWatcher.on('all', () => {
      void git(root, ['rev-parse', 'HEAD']).then((r) => {
        const head = r.ok ? r.stdout.trim() : null;
        if (head && head !== lastHead) {
          opts.onEvent({ type: 'git-head', head: { from: lastHead, to: head } });
          lastHead = head;
          schedule();
        }
      });
    });
    headWatcher.on('error', () => {});
  }

  await ready;
  opts.onEvent({ type: 'ready' });

  const close = async () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    await Promise.all([watcher.close(), headWatcher?.close()]);
  };
  opts.signal?.addEventListener('abort', () => void close(), { once: true });

  return {
    planNow: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      return run();
    },
    latestPlan: () => latest,
    close,
  };
}
