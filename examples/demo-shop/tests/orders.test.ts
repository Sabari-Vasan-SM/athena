import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('orders API', () => {
  beforeEach(() => {
    process.env.API_TOKEN = 'test-token';
  });

  it('rejects orders without a token', async () => {
    const res = await request(createApp()).post('/orders').send({ email: 'a@example.com', items: [] });
    expect(res.status).toBe(401);
  });

  it('validates the order body', async () => {
    const res = await request(createApp()).post('/orders').set('authorization', 'Bearer test-token').send({ email: 'not-an-email', items: [] });
    expect(res.status).toBe(400);
  });

  it('reports health', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.body).toEqual({ ok: true });
  });
});
