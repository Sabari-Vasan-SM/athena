import { execFile } from 'node:child_process';
import { browserUrl, findRunningInstance, startServer } from '../../server/instance.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { AthenaError } from '../../services/errors.js';
import * as ui from '../ui/term.js';
import { printHeader } from '../ui/brand.js';

export interface OpenOptions extends GlobalOptions {
  port?: string;
  host?: string;
  open?: boolean;
  allowRemote?: boolean;
  watch?: boolean;
  signal: AbortSignal;
}

/** Open a URL in the default browser using fixed argv (no shell parsing). */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const child = execFile(cmd, args as string[], { windowsHide: true }, () => {});
  child.on('error', () => {});
  child.unref();
}

export async function openCommand(opts: OpenOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const shouldOpen = opts.open !== false;

  const existing = await findRunningInstance(root);
  if (existing) {
    const url = browserUrl(existing);
    if (ui.isJson()) ui.json({ running: true, reused: true, url, port: existing.port, pid: existing.pid });
    else {
      ui.ok(`Athena is already running for this project ${ui.dim(`(pid ${existing.pid})`)}`);
      ui.line();
      ui.line(`Local: ${ui.c.cyan(url)}`);
    }
    if (shouldOpen) openBrowser(url);
    return;
  }

  let port: number | undefined;
  if (opts.port !== undefined) {
    port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AthenaError(`Invalid port: ${opts.port}`);
  }
  const host = opts.host ?? '127.0.0.1';

  let running;
  try {
    running = await startServer({ root, host, port, allowRemote: opts.allowRemote, watch: opts.watch !== false });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') throw new AthenaError(`Port ${port} is already in use.`, 'Omit --port to pick a free port automatically.');
    throw new AthenaError(e.message);
  }

  if (ui.isJson()) ui.json({ running: true, reused: false, url: running.url, port: running.info.port, pid: process.pid });
  else {
    printHeader();
    ui.line(ui.c.bold(ui.c.green('Athena is running')));
    ui.line();
    ui.line(`Local: ${ui.c.cyan(running.url)}`);
    if (opts.allowRemote) ui.warn(ui.c.yellow(`Bound to ${host} — reachable from other machines. The access token in the URL is required for every API call.`));
    ui.line();
    ui.line(ui.dim(opts.watch === false ? 'File watching is off.' : 'Watching for changes — knowledge updates are proposed in the UI, never applied without your review.'));
    ui.line(ui.dim('The link contains a private access token. Press Ctrl+C to stop.'));
  }
  if (shouldOpen) openBrowser(running.url);
  ui.setInterruptMessage('Stopping Athena server...');

  await new Promise<void>((resolve) => {
    if (opts.signal.aborted) resolve();
    opts.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await running.close();
  if (!ui.isJson()) ui.line(ui.dim('Athena server stopped.'));
}
