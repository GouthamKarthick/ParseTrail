import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { authenticate } from './auth.js';
import { config } from '../config.js';

function invoke(token?: string) {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn();
  authenticate(req, res, next);
  return { req, res, next };
}

describe('authenticate', () => {
  it('rejects requests without a token even in test mode', () => {
    const { res, next } = invoke();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unverified user claim', () => {
    const token = jwt.sign(
      { id: 'user-1', email: 'user@example.com', emailVerified: false },
      config.jwtSecret,
      { algorithm: 'HS256' }
    );
    const { res, next } = invoke(token);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a verified HS256 token', () => {
    const token = jwt.sign(
      { id: 'user-1', email: 'user@example.com', emailVerified: true },
      config.jwtSecret,
      { algorithm: 'HS256' }
    );
    const { req, next } = invoke(token);
    expect((req as Request & { user?: { id: string } }).user?.id).toBe('user-1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects other JWT algorithms', () => {
    const token = jwt.sign(
      { id: 'user-1', email: 'user@example.com', emailVerified: true },
      config.jwtSecret,
      { algorithm: 'HS384' }
    );
    const { res, next } = invoke(token);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
