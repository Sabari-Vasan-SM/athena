import type { FastifyInstance } from 'fastify';
import { SECURITY_HEADERS } from '../security.js';
import type { SseHub } from '../sse.js';

/** GET /api/events: the live event stream (SSE), fanned out by the hub. */
export function registerEventRoutes(app: FastifyInstance, hub: SseHub): void {
  app.addHook('preClose', async () => {
    hub.close();
  });

  app.get('/api/events', (req, reply) => {
    if (hub.full) {
      reply.header('Retry-After', '5');
      reply.code(503).send({ error: 'Too many open event streams', hint: 'Close other Athena tabs and reload.' });
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const detach = hub.add({
      write: (chunk) => res.write(chunk),
      once: (event, listener) => res.once(event, listener),
      end: () => {
        res.end();
        res.socket?.destroy();
      },
    });
    req.raw.on('close', detach);
  });
}
