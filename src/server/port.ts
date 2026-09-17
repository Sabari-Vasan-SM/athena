import net from 'node:net';

export const DEFAULT_PORT = 7432;

export function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** First free port at or after `start`. Never silently binds a port another process owns. */
export async function findAvailablePort(host: string, start = DEFAULT_PORT, attempts = 100): Promise<number> {
  for (let p = start; p < start + attempts && p <= 65535; p++) {
    if (await isPortFree(p, host)) return p;
  }
  throw new Error(`No free port found in ${start}-${start + attempts - 1} on ${host}`);
}
