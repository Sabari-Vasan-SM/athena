import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export const SECURITY_HEADERS: Record<string, string> = {
  // Scripts only from our own origin. Inline styles are required by CodeMirror and Mermaid SVG output.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export interface GuardOptions {
  token: string;
  /** Allowed Host header values, e.g. "127.0.0.1:7432". Empty = allow any (explicit remote mode). */
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Request guard:
 *  - Host allowlist defeats DNS rebinding.
 *  - Bearer token on every /api route (except health) defeats other local sites and processes.
 *  - Origin check + JSON-only bodies on unsafe methods add CSRF defense in depth.
 */
export function makeGuard(opts: GuardOptions) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    if (opts.allowedHosts.size && !opts.allowedHosts.has(host)) {
      await reply.code(421).send({ error: 'Host not allowed' });
      return;
    }
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/') || url === '/api/health') return;

    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !tokensEqual(token, opts.token)) {
      await reply.code(401).send({ error: 'Unauthorized', hint: 'Open the URL printed by `athena open`.' });
      return;
    }
    if (UNSAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && opts.allowedOrigins.size && !opts.allowedOrigins.has(origin.toLowerCase())) {
        await reply.code(403).send({ error: 'Origin not allowed' });
        return;
      }
      const ct = req.headers['content-type'] ?? '';
      const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'];
      if (hasBody && !ct.toLowerCase().startsWith('application/json')) {
        await reply.code(415).send({ error: 'Content-Type must be application/json' });
        return;
      }
    }
  };
}

export function allowedHostsFor(host: string, port: number): Set<string> {
  const hosts = new Set<string>();
  const names = isLoopbackHost(host) ? ['127.0.0.1', 'localhost', '[::1]'] : [host];
  for (const n of names) hosts.add(`${n}:${port}`.toLowerCase());
  return hosts;
}

export function allowedOriginsFor(host: string, port: number): Set<string> {
  return new Set([...allowedHostsFor(host, port)].map((h) => `http://${h}`));
}
