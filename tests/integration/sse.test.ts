import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/app.js';
import { EventBus } from '../../src/server/events.js';
import { SseHub, type SseSink } from '../../src/server/sse.js';
import { cleanupProjects, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

/** A response stand-in: records writes, and reports congestion until drain() is called. */
class FakeSink extends EventEmitter implements SseSink {
  chunks: string[] = [];
  congested = false;
  ended = false;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.congested;
  }
  end(): void {
    this.ended = true;
  }
  drain(): void {
    this.congested = false;
    this.emit('drain');
  }
  get text(): string {
    return this.chunks.join('');
  }
}

const emit = (bus: EventBus, i: number) => bus.emit({ source: 'athena', type: 'test.tick', level: 'info', message: `tick ${i}` });
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('SSE hub', () => {
  it('sends the current activity on connect and coalesces a burst into one write', async () => {
    const bus = new EventBus();
    const hub = new SseHub(bus, { coalesceMs: 30 });
    const sink = new FakeSink();
    hub.add(sink);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toContain('event: activity');

    for (let i = 0; i < 20; i++) emit(bus, i);
    for (let i = 0; i < 5; i++) bus.setActivity({ state: 'ANALYZING', actor: 'athena', task: `step ${i}`, reading: [] });
    expect(sink.chunks).toHaveLength(1); // nothing written yet
    await new Promise((r) => setTimeout(r, 60));
    expect(sink.chunks).toHaveLength(2);
    const batch = sink.chunks[1]!;
    expect(count(batch, 'event: event')).toBe(20);
    // Intermediate activity states are collapsed to the latest.
    expect(count(batch, 'event: activity')).toBe(1);
    expect(batch).toContain('step 4');
    expect(batch.indexOf('tick 0')).toBeLessThan(batch.indexOf('tick 19'));
    hub.close();
    bus.close();
  });

  it('stops writing to a congested client, bounds its queue, and resyncs after drain', () => {
    const bus = new EventBus();
    const hub = new SseHub(bus, { coalesceMs: 10_000, maxPending: 10 });
    const slow = new FakeSink();
    const fast = new FakeSink();
    hub.add(slow);
    hub.add(fast);

    emit(bus, 0);
    slow.congested = true;
    hub.flush(); // slow's write returns false: it is now waiting for drain
    const slowWrites = slow.chunks.length;

    // Many coalescing windows pass while the slow client is stuck.
    for (let i = 1; i <= 500; i++) {
      emit(bus, i);
      if (i % 5 === 0) hub.flush();
    }
    bus.setActivity({ state: 'REVIEWING', actor: 'athena', task: 'latest', reading: [] });
    hub.flush();
    expect(slow.chunks.length).toBe(slowWrites); // nothing written while congested
    expect(count(fast.text, 'event: event')).toBe(501); // other clients are unaffected

    slow.drain();
    const after = slow.chunks.slice(slowWrites).join('');
    expect(after).toContain('event: resync');
    expect(after).toContain('"dropped":490');
    expect(count(after, 'event: event')).toBe(10); // only the newest queued events survive
    expect(after).toContain('tick 500');
    expect(after).not.toContain('tick 490"');
    expect(after).toContain('"task":"latest"');
    hub.close();
    bus.close();
  });

  it('refuses streams beyond the client cap', async () => {
    const root = await makeProject({ '.athena/rules.md': '# Rules\n' });
    const s = await createServer({ root, token: 't0ken-0123456789abcdefghijklmnopqrstu', host: '127.0.0.1', port: 7999, webDir: root, sse: { maxClients: 2 } });
    await s.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (s.app.server.address() as AddressInfo).port;
    const open = () =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: '127.0.0.1:7999', authorization: 'Bearer t0ken-0123456789abcdefghijklmnopqrstu' } }, resolve).on('error', reject);
      });
    try {
      const a = await open();
      const b = await open();
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const c = await open();
      expect(c.statusCode).toBe(503);
      c.resume();
      a.destroy();
      await new Promise((r) => setTimeout(r, 50));
      const d = await open();
      expect(d.statusCode).toBe(200);
      b.destroy();
      d.destroy();
    } finally {
      await s.close();
    }
  });

  it('keeps a paused real client bounded and delivers the latest state when it resumes', async () => {
    const root = await makeProject({ '.athena/rules.md': '# Rules\n' });
    const token = 't0ken-0123456789abcdefghijklmnopqrstu';
    const s = await createServer({ root, token, host: '127.0.0.1', port: 7999, webDir: root, sse: { coalesceMs: 5 } });
    await s.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (s.app.server.address() as AddressInfo).port;
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: '127.0.0.1:7999', authorization: `Bearer ${token}` } }, resolve).on('error', reject);
      });
      expect(res.statusCode).toBe(200);
      res.pause(); // a slow client: stop reading

      // ~40 MB of events: far more than socket buffers hold.
      const big = 'x'.repeat(4000);
      for (let round = 0; round < 100; round++) {
        for (let i = 0; i < 100; i++) s.events.emit({ source: 'athena', type: 'test.big', level: 'info', message: `${round}:${i} ${big}` });
        await new Promise((r) => setTimeout(r, 10));
      }
      s.events.setActivity({ state: 'SUCCESS', actor: 'athena', task: 'final-state', reading: [] });
      await new Promise((r) => setTimeout(r, 50));

      let received = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (received += d));
      res.resume();
      for (let i = 0; i < 200 && !received.includes('final-state'); i++) await new Promise((r) => setTimeout(r, 25));
      expect(received).toContain('final-state');
      expect(received).toContain('event: resync');
      // Most of the ~40 MB was dropped instead of buffered.
      expect(received.length).toBeLessThan(10 * 1024 * 1024);
      res.destroy();
    } finally {
      await s.close();
    }
  }, 30_000);
});
