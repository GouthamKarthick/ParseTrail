import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { authenticate } from './auth.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn() },
}));

function userRow(passwordChangedAt: Date | null = null) {
  return [[{ id: 'user-1', password_changed_at: passwordChangedAt }]];
}

async function invoke(token?: string) {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn();
  await authenticate(req, res, next);
  return { req, res, next };
}

describe('authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue(userRow(null));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests without a token even in test mode', async () => {
    const { res, next } = await invoke();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unverified user claim', async () => {
    const token = jwt.sign(
      { id: 'user-1', email: 'user@example.com', emailVerified: false },
      config.jwtSecret,
      { algorithm: 'HS256' }
    );
    const { res, next } = await invoke(token);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a verified HS256 token', async () => {
    const token = jwt.sign(
      { id: 'user-1', email: 'user@example.com', emailVerified: true },
      config.jwtSecret,
      { algorithm: 'HS256' }
    );
    const { req, next } = await invoke(token);
    expect((req as Request & { user?: { id: string } }).user?.id).toBe('user-1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a JWT issued before password_changed_at', async () => {
    vi.spyOn(jwt, 'verify').mockReturnValue({
      id: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      iat: 1000000, // issued long before the password reset
    } as any);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      userRow(new Date()) // password changed after JWT issued
    );
    const { res, next } = await invoke('any-token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    (jwt.verify as ReturnType<typeof vi.fn>).mockRestore();
  });

  it('rejects other JWT algorithms', async () => {
    const token = jwt.sign(
      { id: 'user-1', email: 'user@example.com', emailVerified: true },
      config.jwtSecret,
      { algorithm: 'HS384' }
    );
    const { res, next } = await invoke(token);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
