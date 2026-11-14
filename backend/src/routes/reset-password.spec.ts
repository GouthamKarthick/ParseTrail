/**
 * routes/reset-password.spec.ts — Password reset atomic claim, JWT invalidation,
 * deleted-user rejection, and rate limiting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';

function mockConn(queryResults: Array<unknown>) {
  const q = vi.fn();
  queryResults.forEach(r => q.mockResolvedValueOnce(r));
  return {
    query: q,
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  } as any;
}

const baseToken = () =>
  jwt.sign({ id: 'u1', email: 'user@example.com', emailVerified: true }, config.jwtSecret, {
    algorithm: 'HS256',
  });

describe('routes — password reset', () => {
  beforeEach(() => {
    vi.spyOn(pool, 'getConnection').mockResolvedValue(mockConn([]));
    vi.spyOn(pool, 'query');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('claims the token atomically: first use succeeds, second use gets affectedRows 0 → 400', async () => {
    const c1 = mockConn([
      [{ affectedRows: 1 }], // claim UPDATE
      [[{ user_id: 'u1' }]], // SELECT user_id
      [{ affectedRows: 1 }], // mark others UPDATE
      [{ affectedRows: 1 }], // UPDATE users password
    ]);
    (pool.getConnection as ReturnType<typeof vi.fn>).mockResolvedValue(c1);

    const app = createApp();
    const res1 = await request(app)
      .post('/api/auth/reset-password')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'reset-token-1', password: 'NewPassword1!' });
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual({ ok: true });

    // 2nd request with same token: claim affectedRows=0 → 400.
    const c2 = mockConn([[{ affectedRows: 0 }]]); // claim UPDATE
    (pool.getConnection as ReturnType<typeof vi.fn>).mockResolvedValue(c2);
    const res2 = await request(app)
      .post('/api/auth/reset-password')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'reset-token-1', password: 'NewPassword1!' });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toBe('Invalid or expired token');
  });

  it('returns 400 when token does not exist or is already used', async () => {
    const c = mockConn([[{ affectedRows: 0 }]]); // claim UPDATE
    (pool.getConnection as ReturnType<typeof vi.fn>).mockResolvedValue(c);
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'stale-token', password: 'NewPassword1!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('rejects invalid password (zod schema)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .set('Origin', 'http://localhost:5173')
      .send({ token: 'reset-token-1', password: 'weak' });
    expect(res.status).toBe(400);
  });
});

describe('authenticate — JWT invalidation after reset', () => {
  it('rejects a JWT issued before password_changed_at', async () => {
    const { authenticate } = await import('../middleware/auth.js');
    vi.spyOn(jwt, 'verify').mockReturnValue({
      id: 'u1',
      email: 'user@example.com',
      emailVerified: true,
      iat: 1000000, // issued long before the password reset
    } as any);
    const changedAt = new Date(); // reset happened after the JWT was issued
    (vi.spyOn(pool, 'query') as any).mockResolvedValueOnce([
      [{ id: 'u1', password_changed_at: changedAt }],
    ]);

    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const req: any = { cookies: {}, headers: { authorization: `Bearer any-token` } };
    await authenticate(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    (jwt.verify as ReturnType<typeof vi.fn>).mockRestore();
  });

  it('rejects a JWT when the user no longer exists', async () => {
    const { authenticate } = await import('../middleware/auth.js');
    const token = baseToken();
    (vi.spyOn(pool, 'query') as any).mockResolvedValueOnce([[]]); // no such user

    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const req: any = { cookies: {}, headers: { authorization: `Bearer ${token}` } };
    await authenticate(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
  });

  it('accepts a valid JWT issued after password_changed_at', async () => {
    const { authenticate } = await import('../middleware/auth.js');
    const token = baseToken(); // issued now
    const changedAt = new Date(Date.now() - 3600 * 1000); // reset was 1h ago, JWT after it
    (vi.spyOn(pool, 'query') as any).mockResolvedValueOnce([
      [{ id: 'u1', password_changed_at: changedAt }],
    ]);

    let nextCalled = false;
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req: any = { cookies: {}, headers: { authorization: `Bearer ${token}` }, user: null };
    await authenticate(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('routes — reset-password rate limit', () => {
  it('returns 429 when the reset-password rate limit is exceeded', async () => {
    const c = mockConn([[{ affectedRows: 0 }]]); // claim UPDATE (never reached due to rate limit)
    vi.spyOn(pool, 'getConnection').mockResolvedValue(c);
    const app = createApp();
    let status429 = false;
    for (let i = 0; i < 35; i++) {
      const res = await request(app)
        .post('/api/auth/reset-password')
        .set('Origin', 'http://localhost:5173')
        .send({ token: 'x', password: 'NewPassword1!' });
      if (res.status === 429) {
        status429 = true;
        break;
      }
    }
    expect(status429).toBe(true);
  });
});
