import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';
import { createServer, type AthenaServer } from './app.js';
import { DEFAULT_PORT, findAvailablePort } from './port.js';
import { generateToken, isLoopbackHost } from './security.js';
import { INSTANCE_FILE, type InstanceInfo } from '../services/instance.js';

export { findRunningInstance, INSTANCE_FILE, type InstanceInfo } from '../services/instance.js';


export interface StartOptions {
  root: string;
  host?: string;
  port?: number;
  allowRemote?: boolean;
  webDir?: string;
  watch?: boolean;
}

export interface RunningServer {
  server: AthenaServer;
  info: InstanceInfo;
  url: string;
  close(): Promise<void>;
}

/** Location of built UI assets: dist/web next to the bundled CLI. */
export function defaultWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/cli.js → dist/web. Source (tests/dev): src/server → dist/web.
  return path.basename(here) === 'dist' ? path.join(here, 'web') : path.resolve(here, '../../dist/web');
}

export function browserUrl(info: Pick<InstanceInfo, 'host' | 'port' | 'token'>): string {
  const host = info.host.includes(':') ? `[${info.host}]` : info.host;
  // The token travels in the URL fragment, which browsers never send to servers or put in Referer headers.
  return `http://${host}:${info.port}/#token=${info.token}`;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && !opts.allowRemote) {
    throw new Error(`Refusing to bind to non-loopback address ${host} without --allow-remote.`);
  }
  const port = opts.port ?? (await findAvailablePort(host, DEFAULT_PORT));
  const token = generateToken();
  const server = await createServer({ root: opts.root, token, host, port, webDir: opts.webDir ?? defaultWebDir(), allowRemote: opts.allowRemote, watch: opts.watch ?? true });
  await server.app.listen({ host, port });
  const info: InstanceInfo = { pid: process.pid, host, port, instanceId: server.instanceId, token, startedAt: new Date().toISOString() };
  const file = path.join(athenaDir(opts.root), INSTANCE_FILE);
  await fs.writeFile(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await ensureGitignored(opts.root, INSTANCE_FILE);
  return {
    server,
    info,
    url: browserUrl(info),
    async close() {
      const current = await readTextIfExists(file);
      if (current && current.includes(server.instanceId)) await fs.rm(file, { force: true });
      await server.close();
    },
  };
}

async function ensureGitignored(root: string, entry: string): Promise<void> {
  const file = path.join(athenaDir(root), '.gitignore');
  const text = (await readTextIfExists(file)) ?? '';
  if (text.split(/\r?\n/).includes(entry)) return;
  await fs.writeFile(file, `${text}${text.endsWith('\n') || !text ? '' : '\n'}${entry}\n`);
}
