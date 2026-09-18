import path from 'node:path';
import { appendEvent } from '../../services/agent-activity.js';
import { findProjectRoot } from '../../services/project.js';
import { normalizeHookEvent } from '../../agents/common/hook-events.js';

export interface EventOptions {
  agent?: string;
  hook?: string;
  cwd?: string;
  verbose?: boolean;
}

const STDIN_TIMEOUT_MS = 2000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      process.stdin.removeAllListeners();
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_PAYLOAD_BYTES) finish();
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Record one agent hook event. Designed to be called by coding agents:
 * it never writes to stdout (agents may parse it), never blocks the agent,
 * and always exits 0 so a failure here cannot break someone's session.
 */
export async function eventCommand(opts: EventOptions): Promise<void> {
  try {
    const raw = await readStdin();
    let payload: Record<string, unknown> = {};
    if (raw.trim().startsWith('{')) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    const cwdCandidates = [opts.cwd, typeof payload.cwd === 'string' ? payload.cwd : undefined, Array.isArray(payload.workspace_roots) ? (payload.workspace_roots as unknown[]).find((x) => typeof x === 'string') as string | undefined : undefined, process.cwd()];
    let root: string | null = null;
    for (const c of cwdCandidates) {
      if (!c) continue;
      root = await findProjectRoot(path.resolve(c));
      if (root) break;
    }
    if (!root) return; // project not initialized: nothing to record

    const event = normalizeHookEvent(opts.agent ?? 'unknown', opts.hook ?? '', payload);
    if (!event) return;
    await appendEvent(root, event);
  } catch (err) {
    if (opts.verbose) process.stderr.write(`athena event: ${(err as Error).message}\n`);
  }
}
