import { promises as fs } from 'node:fs';
import type { AgentEvent } from '../../agents/common/hook-events.js';
import { listAgents } from '../../services/agents.js';
import { activityFile, parseEventLines, readRecentEvents, rotatedActivityFile, summarizeSessions } from '../../services/agent-activity.js';
import type { ServerContext } from '../context.js';

/** Agent activity is only shown while it is fresh; after this it reverts to idle. */
const AGENT_IDLE_MS = 5 * 60 * 1000;

/** GET /api/activity: current activity, recent events, agent sessions and whether agents report activity. */
export function registerActivityRoutes({ app, root, events }: ServerContext): void {
  app.get('/api/activity', async () => {
    const agents = await listAgents(root);
    const observing = agents.filter((a) => a.activityObservation === 'hooks');
    return {
      activity: events.activity(),
      events: events.recent(),
      sessions: summarizeSessions(await readRecentEvents(root, 500)),
      agentObservation: {
        available: observing.length > 0,
        agents: observing.map((a) => a.name),
        reason: observing.length
          ? 'Events below come from hooks the agent fired. Athena sees which tool ran and on which files — never the agent\'s reasoning.'
          : 'No agent is reporting activity yet. Configure an agent with hooks (Claude Code or Cursor) to see its actions here.',
      },
    };
  });
}

export interface AgentActivityFeed {
  /** Seed the timeline with agent events recorded while the UI was closed, and start tailing from the end. */
  seed(): Promise<void>;
  /** Apply lines appended to the activity log since the last read (handles rotation and truncation). */
  readNew(): Promise<void>;
}

/** Tails `.athena/.agent-events.jsonl` (written by agent hooks) into the event bus. */
export function createAgentActivityFeed({ root, events, state }: ServerContext): AgentActivityFeed {
  let offset = 0;
  let ino: number | null = null;

  const toAthenaEvent = (e: AgentEvent) => ({
    id: e.id,
    ts: e.ts,
    source: 'agent' as const,
    type: `agent.${e.kind}`,
    level: (e.kind === 'stop' ? 'success' : 'info') as 'success' | 'info',
    message: `${e.agent}: ${e.message}`,
    data: { agent: e.agent, session: e.session, hook: e.hook, files: e.files, command: e.command, tool: e.tool },
  });

  const apply = (e: AgentEvent, live: boolean) => {
    if (events.has(e.id)) return;
    if (live) events.emit(toAthenaEvent(e));
    else events.seed([{ ...toAthenaEvent(e) }]);
    if (!live) return;
    if (e.state === 'IDLE') {
      if (events.activity().actor === 'agent') events.setActivity({ state: 'IDLE', actor: 'none', task: null, reading: [] });
      return;
    }
    // Athena's own analysis takes precedence only while it is running.
    if (state.analysisRunning) return;
    events.setActivity({ state: e.state, actor: 'agent', task: `${e.agent}: ${e.message}`, reading: e.files.slice(0, 4) }, e.state === 'SUCCESS' ? 10_000 : AGENT_IDLE_MS);
  };

  /** Apply complete lines from `file` starting at `from`; returns the new offset. */
  const readLinesFrom = async (file: string, from: number, size: number): Promise<number> => {
    if (size <= from) return from;
    const handle = await fs.open(file, 'r');
    try {
      const length = size - from;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, from);
      const text = buf.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) return from; // partial line; wait for the rest
      for (const e of parseEventLines(text.slice(0, lastNewline + 1))) apply(e, true);
      return from + Buffer.byteLength(text.slice(0, lastNewline + 1));
    } finally {
      await handle.close();
    }
  };

  return {
    async seed() {
      const history = await readRecentEvents(root, 200);
      for (const e of history) apply(e, false);
      const st = await fs.stat(activityFile(root)).catch(() => null);
      offset = st?.size ?? 0;
      ino = st?.ino ?? null;
    },
    async readNew() {
      try {
        const file = activityFile(root);
        const st = await fs.stat(file).catch(() => null);
        if (!st) return;
        if (ino !== null && st.ino !== ino) {
          // Rotated (renamed to the .1 file): finish what was appended there before the rename.
          const old = await fs.stat(rotatedActivityFile(root)).catch(() => null);
          if (old && old.ino === ino) await readLinesFrom(rotatedActivityFile(root), offset, old.size).catch(() => {});
          offset = 0;
        } else if (st.size < offset) offset = 0; // truncated
        ino = st.ino;
        offset = await readLinesFrom(file, offset, st.size);
      } catch {
        /* activity log unreadable: ignore */
      }
    },
  };
}
