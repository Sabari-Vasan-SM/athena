import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { MISSING_UI_HTML, type StaticAsset } from '../static.js';

/** The built web UI: allowlisted assets by exact path, SPA fallback to index.html. Register last. */
export function registerStaticRoutes(app: FastifyInstance, assets: Map<string, StaticAsset> | null): void {
  const sendAsset = async (reply: FastifyReply, urlPath: string) => {
    if (!assets) return reply.code(503).type('text/html; charset=utf-8').send(MISSING_UI_HTML);
    const asset = assets.get(urlPath) ?? assets.get('/index.html')!;
    const body = await fs.readFile(asset.abs);
    reply.header('Cache-Control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.type(asset.type).send(body);
  };
  app.route({
    method: 'GET',
    url: '/*',
    handler: async (req, reply) => {
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(req.url.split('?')[0]!);
      } catch {
        return reply.code(400).send('Bad request');
      }
      if (urlPath.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      // Unknown extensions are SPA routes only when they look like app paths (no dot).
      if (assets && !assets.has(urlPath) && /\.[a-z0-9]+$/i.test(urlPath)) return reply.code(404).send('Not found');
      return sendAsset(reply, urlPath === '/' ? '/index.html' : urlPath);
    },
  });
}
