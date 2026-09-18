import { promises as fs } from 'node:fs';
import path from 'node:path';
import { athenaDir } from '../core/state/state.js';
import { redact } from '../core/security/secrets.js';
import { toPosix } from '../core/util/paths.js';
import type { AgentEvent } from '../agents/common/hook-events.js';

/**
 * Agent activity log. Hooks append one JSON object per line; the local server
 * tails the file. No network, no token, and it keeps working when the UI is closed.
 */
export const ACTIVITY_FILE = '.agent-events.jsonl';
const MAX_LINES = 2000;
const MAX_BYTES = 512 * 1024;

export function activityFile(root: string): string {
  return path.join(athenaDir(root), ACTIVITY_FILE);
}

/** Make paths project-relative and strip anything secret-looking before it is stored. */
export function sanitizeEvent(root: string, event: AgentEvent): AgentEvent {
  const rel = (p: string) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
    const r = toPosix(path.relative(root, abs));
    return !r || r.startsWith('..') ? toPosix(p) : r;
  };
  // Hook payloads carry absolute paths; keep the log project-relative and portable.
  const stripRoot = (text: string) => text.split(`${root}${path.sep}`).join('').split(toPosix(root) + '/').join('');
  return {
    ...event,
    message: redact(stripRoot(event.message)),
    command: event.command ? redact(stripRoot(event.command)) : null,
    files: event.files.map(rel),
  };
}

export async function appendEvent(root: string, event: AgentEvent): Promise<void> {
  const file = activityFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(sanitizeEvent(root, event))}\n`);
  await rotateIfNeeded(file);
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const st = await fs.stat(file);
    if (st.size < MAX_BYTES) return;
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
    await fs.writeFile(file, `${lines.slice(-MAX_LINES / 2).join('\n')}\n`);
  } catch {
    /* rotation is best-effort */
  }
}

export function parseEventLines(text: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AgentEvent;
      if (e && typeof e.id === 'string' && typeof e.ts === 'string' && typeof e.agent === 'string') out.push(e);
    } catch {
      /* skip malformed lines (partial write) */
    }
  }
  return out;
}

export async function readRecentEvents(root: string, limit = 200): Promise<AgentEvent[]> {
  try {
    const text = await fs.readFile(activityFile(root), 'utf8');
    return parseEventLines(text).slice(-limit);
  } catch {
    return [];
  }
}

export interface AgentSession {
  agent: string;
  session: string | null;
  lastEventAt: string;
  lastMessage: string;
  events: number;
}

/** Sessions seen in the log, most recent first. Presence here means "hooks fired", nothing more. */
export function summarizeSessions(events: AgentEvent[]): AgentSession[] {
  const byKey = new Map<string, AgentSession>();
  for (const e of events) {
    const key = `${e.agent}:${e.session ?? '-'}`;
    const cur = byKey.get(key);
    byKey.set(key, { agent: e.agent, session: e.session, lastEventAt: e.ts, lastMessage: e.message, events: (cur?.events ?? 0) + 1 });
  }
  return [...byKey.values()].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
}
