/**
 * middleware/auth.ts — JWT authentication.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';
import { config } from '../config.js';

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: true;
}

/**
 * Authenticates request via cookie or Bearer token.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token =
    (req as unknown as { cookies?: Record<string, string> }).cookies?.token ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
    }) as AuthUser & { iat?: number };
    if (payload.emailVerified !== true) {
      res.status(403).json({
        error: 'Email not verified',
        code: 'EMAIL_NOT_VERIFIED',
      });
      return;
    }
    // One indexed lookup per request: reject if the user no longer exists,
    // or if the JWT was issued before the user's last password reset.
    const [rows] = await pool.query('SELECT id, password_changed_at FROM users WHERE id=?', [
      payload.id,
    ]);
    const user = (rows as Array<{ id: string; password_changed_at: Date | null }>)[0];
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    if (
      user.password_changed_at !== null &&
      typeof payload.iat === 'number' &&
      payload.iat < Math.floor(user.password_changed_at.getTime() / 1000)
    ) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    (req as unknown as { user: AuthUser }).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Extracts authenticated user from request.
 * @param req Express request
 * @returns Auth user or null
 */
export function getUser(req: Request): AuthUser | null {
  return (req as unknown as { user?: AuthUser }).user ?? null;
}
