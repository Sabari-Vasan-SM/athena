import { promises as fs } from 'node:fs';
import path from 'node:path';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';

export const INSTANCE_FILE = '.server.json';

export interface InstanceInfo {
  pid: number;
  host: string;
  port: number;
  instanceId: string;
  token: string;
  startedAt: string;
}

/** Find an already-running Athena server for this project, verified by instance id. */
export async function findRunningInstance(root: string): Promise<InstanceInfo | null> {
  const file = path.join(athenaDir(root), INSTANCE_FILE);
  const raw = await readTextIfExists(file);
  if (!raw) return null;
  let info: InstanceInfo;
  try {
    info = JSON.parse(raw) as InstanceInfo;
  } catch {
    return null;
  }
  if (typeof info.pid !== 'number' || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
  try {
    process.kill(info.pid, 0);
  } catch {
    await fs.rm(file, { force: true }).catch(() => {});
    return null;
  }
  try {
    const host = info.host.includes(':') ? `[${info.host}]` : info.host;
    const res = await fetch(`http://${host}:${info.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { instanceId?: string };
    return body.instanceId === info.instanceId ? info : null;
  } catch {
    return null;
  }
}
