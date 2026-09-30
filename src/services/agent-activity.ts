import { promises as fs } from 'node:fs';
import path from 'node:path';
import { athenaDir } from '../core/paths.js';
import { redact } from '../core/security/secrets.js';
import { toPosix } from '../core/util/paths.js';
import type { AgentEvent } from '../agents/common/hook-events.js';

/**
 * Agent activity log. Hooks append one JSON object per line; the local server
 * tails the file. No network, no token, and it keeps working when the UI is closed.
 */
export const ACTIVITY_FILE = '.agent-events.jsonl';
/** The previous generation, kept after rotation so "recent" reads stay complete. */
export const ROTATED_ACTIVITY_FILE = '.agent-events.1.jsonl';
const ROTATE_LOCK = '.agent-events.rotate.lock';
export const MAX_ACTIVITY_BYTES = 512 * 1024;

export function activityFile(root: string): string {
  return path.join(athenaDir(root), ACTIVITY_FILE);
}

export function rotatedActivityFile(root: string): string {
  return path.join(athenaDir(root), ROTATED_ACTIVITY_FILE);
}

const MASK = '<redacted>';
/**
 * Credentials in command lines that the generic secret patterns can miss because
 * the value itself is low-entropy (e.g. a short password).
 */
const COMMAND_SECRETS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token> / Basic <b64> (headers, curl -H, etc.)
  [/(\bauthorization\s*[:=]\s*["']?\s*(?:bearer|basic|token|digest)\s+)[^\s"',;]+/gi, `$1${MASK}`],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${MASK}`],
  // --password=x, --password x, --passwd "x y"
  [/(--(?:password|passwd|pass)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1${MASK}`],
  // mysql -psecret (attached value; `-p` alone prompts)
  [/(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb|mariadb-dump)\b[^|;&\n]*?\s-p)("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1${MASK}`],
  // scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)(@)/gi, `$1${MASK}$3`],
];

/** Mask command-line credentials, then apply the shared secret redactor. */
export function redactCommandSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of COMMAND_SECRETS) out = out.replace(re, rep);
  return redact(out);
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
    message: redactCommandSecrets(stripRoot(event.message)),
    command: event.command ? redactCommandSecrets(stripRoot(event.command)) : null,
    files: event.files.map(rel),
  };
}

export async function appendEvent(root: string, event: AgentEvent): Promise<void> {
  const file = activityFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(sanitizeEvent(root, event))}\n`);
  await rotateIfNeeded(file);
}

/**
 * Rename-based rotation: `.agent-events.jsonl` → `.agent-events.1.jsonl` (one
 * generation kept). A rename is atomic, so appends racing with rotation land in one
 * file or the other and are never lost or rewritten. A lock file keeps two processes
 * from rotating twice in a row (which would discard the fresh log).
 */
export async function rotateIfNeeded(file: string, maxBytes = MAX_ACTIVITY_BYTES): Promise<void> {
  try {
    const st = await fs.stat(file);
    if (st.size < maxBytes) return;
    const dir = path.dirname(file);
    const lock = path.join(dir, ROTATE_LOCK);
    let handle;
    try {
      handle = await fs.open(lock, 'wx');
    } catch {
      // Someone else is rotating; clear a lock left behind by a crashed process.
      const age = await fs.stat(lock).then((l) => Date.now() - l.mtimeMs).catch(() => 0);
      if (age > 10_000) await fs.rm(lock, { force: true });
      return;
    }
    try {
      const again = await fs.stat(file).catch(() => null);
      if (again && again.size >= maxBytes) await fs.rename(file, path.join(dir, ROTATED_ACTIVITY_FILE));
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
    }
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
  const current = parseEventLines(await fs.readFile(activityFile(root), 'utf8').catch(() => ''));
  if (current.length >= limit) return current.slice(-limit);
  // Just after a rotation the current file is short: fill up from the previous generation.
  const previous = parseEventLines(await fs.readFile(rotatedActivityFile(root), 'utf8').catch(() => ''));
  return [...previous, ...current].slice(-limit);
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
