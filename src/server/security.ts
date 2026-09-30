import crypto from 'node:crypto';
import os from 'node:os';
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
  /** Allowed Host header values, e.g. "127.0.0.1:7432". */
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

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];
const bracket = (h: string) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/**
 * Host header values the server answers to. Loopback binds accept the loopback names.
 * Remote binds (--allow-remote) accept the bind address plus loopback, and for a
 * wildcard bind (0.0.0.0 / ::) this machine's interface addresses and hostname — the
 * allowlist is never disabled, so DNS rebinding stays blocked.
 */
export function allowedHostsFor(host: string, port: number, opts: { remote?: boolean; extraHosts?: string[] } = {}): Set<string> {
  const names = new Set<string>(LOOPBACK_NAMES);
  if (!isLoopbackHost(host)) {
    if (!opts.remote) names.clear();
    if (host === '0.0.0.0' || host === '::') {
      for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) names.add(bracket(a.address));
      names.add(os.hostname());
    } else names.add(bracket(host));
  }
  for (const h of opts.extraHosts ?? []) names.add(bracket(h));
  return new Set([...names].map((n) => `${n}:${port}`.toLowerCase()));
}

export function allowedOriginsFor(host: string, port: number, opts: { remote?: boolean; extraHosts?: string[] } = {}): Set<string> {
  return new Set([...allowedHostsFor(host, port, opts)].map((h) => `http://${h}`));
}

export interface RateLimitOptions {
  /** Sustained requests per second per client. */
  perSecond: number;
  /** Bucket size: requests allowed in a burst. */
  burst: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { perSecond: 30, burst: 120 };

/**
 * In-memory token bucket per client key (IP). Generous by default so the UI never
 * trips it; it exists to blunt token guessing and runaway local scripts.
 */
export function makeRateLimiter(opts: RateLimitOptions, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const MAX_CLIENTS = 10_000;
  return function take(key: string): boolean {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= MAX_CLIENTS) {
        // Drop buckets that have refilled completely; they carry no state.
        for (const [k, v] of buckets) if (v.tokens + ((t - v.at) / 1000) * opts.perSecond >= opts.burst) buckets.delete(k);
        if (buckets.size >= MAX_CLIENTS) buckets.delete(buckets.keys().next().value!);
      }
      b = { tokens: opts.burst, at: t };
      buckets.set(key, b);
    }
    b.tokens = Math.min(opts.burst, b.tokens + ((t - b.at) / 1000) * opts.perSecond);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}
