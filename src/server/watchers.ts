import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DOCS } from '../core/knowledge/documents.js';
import { athenaDir } from '../core/state/state.js';
import { ACTIVITY_FILE } from '../services/agent-activity.js';
import { contentHash } from '../services/knowledge.js';
import { watchProject } from '../services/watch.js';
import type { ServerContext } from './context.js';
import type { AgentActivityFeed } from './routes/activity.js';

/**
 * Watch `.athena/` for external edits to knowledge documents (reported as
 * `knowledge.external-change` unless the write was ours) and for new agent
 * activity. Returns a function that stops watching.
 */
export function watchKnowledgeDir(ctx: ServerContext, feed: AgentActivityFeed): () => void {
  const { events, recentWrites } = ctx;
  let docsWatcher: FSWatcher | null = null;
  const pending = new Map<string, NodeJS.Timeout>();
  try {
    const dir = athenaDir(ctx.root);
    docsWatcher = watch(dir, { persistent: false }, (_type, filename) => {
      const name = filename?.toString();
      if (name === ACTIVITY_FILE) {
        void feed.readNew();
        return;
      }
      // An analysis or sync from another process (e.g. `athena sync` in a terminal).
      if (name === 'state.json') {
        ctx.invalidateStatus();
        return;
      }
      if (!name || !KNOWLEDGE_DOCS.some((d) => d.file === name)) return;
      clearTimeout(pending.get(name));
      pending.set(
        name,
        setTimeout(async () => {
          pending.delete(name);
          const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
          const hash = text === null ? null : contentHash(text);
          if (hash && recentWrites.get(name) === hash) return; // our own write
          ctx.invalidateStatus();
          events.emit({ source: 'filesystem', type: 'knowledge.external-change', level: 'info', message: text === null ? `${name} was deleted on disk` : `${name} changed on disk`, data: { file: name, hash } });
        }, 150),
      );
    });
    docsWatcher.on('error', () => {});
  } catch {
    docsWatcher = null;
  }
  return () => {
    docsWatcher?.close();
    for (const t of pending.values()) clearTimeout(t);
  };
}

/** Watch the project and turn watcher events into sync proposals and activity. */
export async function watchProjectFiles(ctx: ServerContext, debounceMs?: number): Promise<void> {
  const { events, state } = ctx;
  try {
    state.watcher = await watchProject(ctx.root, {
      debounceMs,
      scheduler: ctx.scheduler,
      onEvent: (e) => {
        switch (e.type) {
          case 'changes':
            // The status report is cached until the tree changes (not just for a TTL).
            ctx.invalidateStatus();
            break;
          case 'planning':
            if (!state.analysisRunning) events.setActivity({ state: 'ANALYZING', actor: 'athena', task: e.paths?.length ? `Checking ${e.paths.length} changed file${e.paths.length === 1 ? '' : 's'}` : 'Checking for changes', reading: [] });
            break;
          case 'plan': {
            const plan = e.plan!;
            const prevId = state.currentPlan?.id;
            ctx.setPlan(plan);
            if (!state.analysisRunning) events.setActivity({ state: 'IDLE', actor: 'none', task: null, reading: [] });
            if (!plan.upToDate && !plan.ignored && plan.id !== prevId) {
              events.emit({ source: 'athena', type: 'sync.proposed', level: 'warn', message: `Knowledge update proposed for ${plan.documents.map((d) => d.file).join(', ')}`, data: { planId: plan.id, files: plan.documents.map((d) => d.file) } });
            }
            if (plan.upToDate && prevId) events.emit({ source: 'athena', type: 'sync.up-to-date', level: 'info', message: 'Proposal no longer needed — knowledge is up to date' });
            break;
          }
          case 'refreshed':
            ctx.setPlan(null);
            ctx.invalidateStatus();
            if (!state.analysisRunning) events.setActivity({ state: 'IDLE', actor: 'none', task: null, reading: [] });
            events.emit({ source: 'athena', type: 'sync.up-to-date', level: 'info', message: 'Files changed — knowledge already up to date (index refreshed)' });
            break;
          case 'git-head':
            ctx.invalidateStatus();
            events.emit({ source: 'filesystem', type: 'git.head', level: 'info', message: `Git HEAD moved ${e.head?.from?.slice(0, 8) ?? '?'} → ${e.head?.to?.slice(0, 8) ?? '?'}` });
            break;
          case 'error':
            if (!state.analysisRunning) events.setActivity({ state: 'ERROR', actor: 'athena', task: 'Change check failed', reading: [] }, 6000);
            events.emit({ source: 'athena', type: 'sync.error', level: 'error', message: `Change check failed: ${e.error?.message ?? 'unknown error'}` });
            break;
          default:
            break;
        }
      },
    });
    void state.watcher.planNow();
  } catch (err) {
    events.emit({ source: 'athena', type: 'sync.error', level: 'error', message: `File watching unavailable: ${(err as Error).message}` });
  }
}
