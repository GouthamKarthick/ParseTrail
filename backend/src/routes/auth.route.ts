/**
 * routes/auth.route.ts — Authentication endpoints.
 */

import { Router, type Response } from 'express';
import { createHash, randomInt, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { sendVerificationEmail, sendResetEmail } from '../services/email.service.js';
import { authenticate } from '../middleware/auth.js';
import { isSuspicious } from '../utils/security.js';
import { logger } from '../config/logger.js';

const router = Router();

// Dummy bcrypt hash used when the email is not found, so bcrypt.compare always
// runs and response time does not reveal whether the email exists.
const DUMMY_HASH = bcrypt.hashSync('never-used-dummy-password', 12);

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Z]/, 'Password must contain at least 1 uppercase letter')
  .regex(/\d/, 'Password must contain at least 1 number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least 1 special character');
const nameSchema = z.string().trim().min(1, 'Required').max(50);
const registerSchema = z.object({
  first_name: nameSchema,
  last_name: nameSchema,
  email: z
    .string()
    .trim()
    .email()
    .transform(email => email.toLowerCase()),
  password: passwordSchema,
});
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform(email => email.toLowerCase()),
  password: z.string().min(1),
});
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

/**
 * Signs a JWT for a user.
 * @param id User id
 * @param email User email
 * @returns JWT string
 */
function signToken(id: string, email: string) {
  return jwt.sign({ id, email, emailVerified: true }, config.jwtSecret, {
    expiresIn: config.jwtExpiry as unknown as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

function setAuthCookie(res: Response, token: string) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.isProduction || config.cookieSameSite === 'none',
    maxAge: 24 * 60 * 60 * 1000,
  });
}

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

router.post('/register', async (req, res) => {
  if (
    isSuspicious(req.body?.email) ||
    isSuspicious(req.body?.first_name) ||
    isSuspicious(req.body?.last_name)
  ) {
    res.status(400).json({
      error: 'Suspicious input detected — not saved',
      code: 'SUSPICIOUS_INPUT',
    });
    return;
  }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => i.message).join('; ');
    res.status(400).json({ error: msg || 'Invalid registration data' });
    return;
  }
  const { first_name, last_name, email, password } = parsed.data;
  if (!config.smtp.host && !config.allowUnverified) {
    res.status(503).json({
      error: 'Email verification is unavailable',
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
    });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const id = randomUUID();
  const verificationToken = randomUUID();
  const verificationCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const verificationExpires = new Date(Date.now() + 15 * 60 * 1000);
  let verificationEmailSent = true;
  try {
    await pool.query(
      'INSERT INTO users (id, email, first_name, last_name, password_hash, verification_token, verification_code, verification_expires) VALUES (?,?,?,?,?,?,?,?)',
      [
        id,
        email,
        first_name.trim(),
        last_name.trim(),
        hash,
        verificationToken,
        verificationCode,
        verificationExpires,
      ]
    );
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === 'ER_DUP_ENTRY') {
      // Email already registered: do not reveal whether it exists. Look up the
      // existing account and respond with the same 201 shape as a new signup.
      const [existing] = await pool.query(
        'SELECT id, email, first_name, last_name, email_verified FROM users WHERE email=?',
        [email]
      );
      const user = (
        existing as Array<{
          id: string;
          email: string;
          first_name: string;
          last_name: string;
          email_verified: number;
        }>
      )[0];
      if (!user) {
        // Should not happen; fall back to generic success to avoid leaking.
        res.status(201).json({
          id,
          email,
          first_name: first_name.trim(),
          last_name: last_name.trim(),
          email_verified: false,
          verification_email_sent: true,
        });
        return;
      }
      const alreadyVerified = Boolean(user.email_verified);
      if (!alreadyVerified && config.smtp.host) {
        // Re-issue verification code for an unverified existing account.
        const verificationToken = randomUUID();
        const verificationCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const verificationExpires = new Date(Date.now() + 15 * 60 * 1000);
        await pool.query(
          'UPDATE users SET verification_token=?, verification_code=?, verification_expires=? WHERE id=?',
          [verificationToken, verificationCode, verificationExpires, user.id]
        );
        try {
          await sendVerificationEmail(user.email, verificationToken, verificationCode);
          res.status(201).json({
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            email_verified: false,
            verification_email_sent: true,
          });
          return;
        } catch (error) {
          logger.error('Verification email re-send after registration failed', {
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          if (config.isProduction) {
            res.status(503).json({
              error: 'Verification email could not be sent; request a new code later',
              code: 'EMAIL_DELIVERY_FAILED',
            });
            return;
          }
        }
      }
      res.status(201).json({
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        email_verified: alreadyVerified,
        verification_email_sent: false,
      });
      return;
    }
    throw e;
  }
  const emailVerified = !config.smtp.host && config.allowUnverified;
  if (emailVerified) {
    await pool.query(
      'UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_code=NULL, verification_expires=NULL, verification_attempts=0 WHERE id=?',
      [id]
    );
  } else if (config.smtp.host) {
    try {
      await sendVerificationEmail(email, verificationToken, verificationCode);
    } catch (error) {
      verificationEmailSent = false;
      logger.error('Verification email delivery failed after registration', {
        userId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (config.isProduction) {
        res.status(503).json({
          error: 'Verification email could not be sent; request a new code later',
          code: 'EMAIL_DELIVERY_FAILED',
        });
        return;
      }
    }
  }
  if (emailVerified) setAuthCookie(res, signToken(id, email));
  res.status(201).json({
    id,
    email,
    first_name: first_name.trim(),
    last_name: last_name.trim(),
    email_verified: emailVerified,
    verification_email_sent: verificationEmailSent,
  });
});

router.post('/login', async (req, res) => {
  if (isSuspicious(req.body?.email)) {
    res.status(400).json({
      error: 'Suspicious input detected — not saved',
      code: 'SUSPICIOUS_INPUT',
    });
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const { email, password } = parsed.data;
  const [rows] = await pool.query(
    'SELECT id, email, first_name, last_name, password_hash, email_verified FROM users WHERE email=?',
    [email.trim().toLowerCase()]
  );
  const user = (
    rows as Array<{
      id: string;
      email: string;
      first_name: string;
      last_name: string;
      password_hash: string;
      email_verified: number;
    }>
  )[0];
  const hash = user ? user.password_hash : DUMMY_HASH;
  const match = await bcrypt.compare(password, hash);
  if (!user || !match) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  if (!user.email_verified) {
    res.status(403).json({
      error: 'Email not verified. Please verify via code/link.',
      code: 'EMAIL_NOT_VERIFIED',
    });
    return;
  }
  const token = signToken(user.id, user.email);
  setAuthCookie(res, token);
  res.json({
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    email_verified: Boolean(user.email_verified),
  });
});

router.post('/logout', (_req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.isProduction || config.cookieSameSite === 'none',
  });
  res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res) => {
  const user = (req as unknown as { user: { id: string; email: string } }).user;
  const [rows] = await pool.query(
    'SELECT id, email, first_name, last_name, phone, email_verified, created_at FROM users WHERE id=?',
    [user.id]
  );
  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(row);
});

/**
 * PATCH /api/auth/profile — phone always editable; first/last editable only
 * when currently empty (legacy accounts); email/avatar immutable here.
 */
router.patch('/profile', authenticate, async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if ('email' in body || 'avatar_base64' in body) {
    res.status(400).json({
      error: 'email and avatar_base64 are immutable via this endpoint',
    });
    return;
  }
  const user = (req as unknown as { user: { id: string } }).user;
  const [existing] = await pool.query('SELECT first_name, last_name FROM users WHERE id=?', [
    user.id,
  ]);
  const current = (existing as Array<{ first_name: string | null; last_name: string | null }>)[0];

  const updates: string[] = [];
  const params: unknown[] = [];

  if ('first_name' in body || 'last_name' in body) {
    const curFirstEmpty = !(current?.first_name || '').trim();
    const curLastEmpty = !(current?.last_name || '').trim();
    const wantFirst = body.first_name !== undefined;
    const wantLast = body.last_name !== undefined;
    if ((wantFirst && !curFirstEmpty) || (wantLast && !curLastEmpty)) {
      res.status(400).json({ error: 'first_name and last_name are immutable once set' });
      return;
    }
    if (wantFirst) {
      const v = String(body.first_name ?? '').trim();
      if (isSuspicious(v) || v.length < 1 || v.length > 50) {
        res.status(400).json({ error: 'Invalid first_name' });
        return;
      }
      updates.push('first_name=?');
      params.push(v);
    }
    if (wantLast) {
      const v = String(body.last_name ?? '').trim();
      if (isSuspicious(v) || v.length < 1 || v.length > 50) {
        res.status(400).json({ error: 'Invalid last_name' });
        return;
      }
      updates.push('last_name=?');
      params.push(v);
    }
  }

  if (body.phone !== undefined) {
    if (isSuspicious(body.phone as string)) {
      res.status(400).json({
        error: 'Suspicious input detected — not saved',
        code: 'SUSPICIOUS_INPUT',
      });
      return;
    }
    const phone =
      typeof body.phone === 'string' ? body.phone.trim().replace(/[\s\-()]/g, '') : body.phone;
    if (
      phone !== undefined &&
      phone !== null &&
      phone !== '' &&
      !/^\+[1-9]\d{7,14}$/.test(phone as string)
    ) {
      res.status(400).json({ error: 'Phone must be E.164 format, e.g. +919876543210' });
      return;
    }
    updates.push('phone=?');
    params.push((phone as string) || null);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }
  await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id=?`, [...params, user.id]);
  const [rows] = await pool.query(
    'SELECT id, email, first_name, last_name, phone, email_verified FROM users WHERE id=?',
    [user.id]
  );
  res.json((rows as Array<Record<string, unknown>>)[0]);
});

/** Avatar helpers — separate API so GET /me stays light. */
function parseAvatarDataUrl(s: string): { mime: string; b64: string } | null {
  const m = s.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[3] };
}

router.get('/avatar', authenticate, async (req, res) => {
  const user = (req as unknown as { user: { id: string } }).user;
  const [rows] = await pool.query(
    'SELECT mime, data, size_bytes FROM user_avatars WHERE user_id=?',
    [user.id]
  );
  const row = (rows as Array<{ mime: string; data: string; size_bytes: number }>)[0];
  if (!row) {
    res.status(404).json({ avatar: null });
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json({
    avatar_base64: `data:${row.mime};base64,${row.data}`,
    mime: row.mime,
    size_bytes: row.size_bytes,
  });
});

router.put('/avatar', authenticate, async (req, res) => {
  const { avatar_base64 } = req.body as { avatar_base64?: string };
  if (!avatar_base64 || typeof avatar_base64 !== 'string') {
    res.status(400).json({ error: 'avatar_base64 required' });
    return;
  }
  if (avatar_base64.length > 1_400_000) {
    res.status(413).json({ error: 'Avatar must be ≤1MB' });
    return;
  }
  const parsed = parseAvatarDataUrl(avatar_base64.trim());
  if (!parsed) {
    res.status(400).json({ error: 'Avatar must be a jpeg/png/webp data URL' });
    return;
  }
  let size_bytes = 0;
  try {
    size_bytes = Buffer.from(parsed.b64, 'base64').length;
  } catch {
    res.status(400).json({ error: 'Invalid Base64' });
    return;
  }
  if (size_bytes > 1_048_576) {
    res.status(413).json({ error: 'Avatar must be ≤1MB' });
    return;
  }
  const user = (req as unknown as { user: { id: string } }).user;
  await pool.query(
    'INSERT INTO user_avatars (user_id, mime, data, size_bytes) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE mime=VALUES(mime), data=VALUES(data), size_bytes=VALUES(size_bytes)',
    [user.id, parsed.mime, parsed.b64, size_bytes]
  );
  res.json({ ok: true, size_bytes });
});

router.delete('/avatar', authenticate, async (req, res) => {
  const user = (req as unknown as { user: { id: string } }).user;
  await pool.query('DELETE FROM user_avatars WHERE user_id=?', [user.id]);
  res.json({ ok: true });
});

router.post('/resend-verification', async (req, res) => {
  if (config.isProduction && !config.smtp.host) {
    res.status(503).json({
      error: 'Email service is not configured',
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
    });
    return;
  }
  const email = (req.body?.email as string)?.trim()?.toLowerCase();
  if (!email) {
    res.status(400).json({ error: 'Email required' });
    return;
  }
  const [rows] = await pool.query('SELECT id, email_verified FROM users WHERE email=?', [email]);
  const user = (rows as Array<{ id: string; email_verified: number }>)[0];
  // Always ok to avoid enumeration; only send if unverified
  if (user && !user.email_verified) {
    const verificationToken = randomUUID();
    const verificationCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'UPDATE users SET verification_token=?, verification_code=?, verification_expires=?, verification_attempts=0 WHERE id=?',
      [verificationToken, verificationCode, verificationExpires, user.id]
    );
    try {
      await sendVerificationEmail(email, verificationToken, verificationCode);
    } catch (error) {
      logger.error('Verification email delivery failed', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (config.isProduction) {
        res.status(503).json({
          error: 'Verification email could not be sent',
          code: 'EMAIL_DELIVERY_FAILED',
        });
        return;
      }
    }
  }
  res.json({ ok: true });
});

router.post('/verify-email', async (req, res) => {
  const token = (req.body?.token as string) || (req.query.token as string);
  const code = (req.body?.code as string) || (req.query.code as string);
  const rawEmail = (req.body?.email as string) || (req.query.email as string);
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!email || !z.string().email().safeParse(email).success) {
    res.status(400).json({ error: 'Valid email required' });
    return;
  }
  if (token) {
    const [rows] = await pool.query(
      'SELECT id, email FROM users WHERE email=? AND verification_token=? AND verification_expires > NOW()',
      [email, token]
    );
    const user = (rows as Array<{ id: string; email: string }>)[0];
    if (!user) {
      res.status(400).json({ error: 'Invalid or expired token' });
      return;
    }
    await pool.query(
      'UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_code=NULL, verification_expires=NULL, verification_attempts=0 WHERE id=?',
      [user.id]
    );
    setAuthCookie(res, signToken(user.id, user.email));
    res.json({ ok: true });
    return;
  }
  if (!code) {
    res.status(400).json({ error: 'Email and code required' });
    return;
  }
  const cleanCode = code.trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    res.status(400).json({ error: 'Code must be 6 digits' });
    return;
  }
  const [rows] = await pool.query(
    'SELECT id, email, verification_code, verification_attempts FROM users WHERE email=? AND verification_code IS NOT NULL AND verification_expires > NOW()',
    [email]
  );
  const user = (
    rows as Array<{
      id: string;
      email: string;
      verification_code: string;
      verification_attempts: number;
    }>
  )[0];
  if (!user) {
    res.status(400).json({ error: 'Invalid or expired code' });
    return;
  }
  if (user.verification_code !== cleanCode) {
    await pool.query(
      'UPDATE users SET verification_attempts=verification_attempts+1, verification_code=IF(verification_attempts+1 >= 5, NULL, verification_code), verification_token=IF(verification_attempts+1 >= 5, NULL, verification_token), verification_expires=IF(verification_attempts+1 >= 5, NULL, verification_expires) WHERE id=? AND verification_attempts < 5',
      [user.id]
    );
    if (user.verification_attempts >= 4) {
      res.status(429).json({
        error: 'Too many incorrect verification codes; request a new code',
        code: 'VERIFICATION_CODE_INVALIDATED',
      });
      return;
    }
    res.status(400).json({ error: 'Invalid or expired code' });
    return;
  }
  const [verified] = await pool.query(
    'UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_code=NULL, verification_expires=NULL, verification_attempts=0 WHERE id=? AND verification_code=? AND verification_expires > NOW() AND verification_attempts < 5',
    [user.id, cleanCode]
  );
  if ((verified as { affectedRows?: number }).affectedRows !== 1) {
    res.status(400).json({ error: 'Invalid or expired code' });
    return;
  }
  setAuthCookie(res, signToken(user.id, user.email));
  res.json({ ok: true });
});

router.post('/forgot-password', async (req, res) => {
  if (config.isProduction && !config.smtp.host) {
    res.status(503).json({
      error: 'Email service is not configured',
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
    });
    return;
  }
  const email = (req.body?.email as string)?.trim()?.toLowerCase();
  if (isSuspicious(email)) {
    res.status(400).json({
      error: 'Suspicious input detected — not saved',
      code: 'SUSPICIOUS_INPUT',
    });
    return;
  }
  if (!email) {
    res.status(400).json({ error: 'Email required' });
    return;
  }
  const [rows] = await pool.query('SELECT id FROM users WHERE email=?', [email]);
  const user = (rows as Array<{ id: string }>)[0];
  if (user) {
    const token = randomUUID();
    const tokenHash = hashResetToken(token);
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)',
      [randomUUID(), user.id, tokenHash, expires]
    );
    try {
      await sendResetEmail(email, token);
    } catch (error) {
      logger.error('Password reset email delivery failed', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (config.isProduction) {
        res.status(503).json({
          error: 'Password reset email could not be sent',
          code: 'EMAIL_DELIVERY_FAILED',
        });
        return;
      }
    }
  }
  res.json({ ok: true });
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body as { token?: string; password?: string };
  const parsed = resetPasswordSchema.safeParse({ token, password });
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => i.message).join('; ');
    res.status(400).json({ error: msg || 'Invalid token or password' });
    return;
  }
  const { token: validToken, password: validPassword } = parsed.data;
  const tokenHash = hashResetToken(validToken);

  try {
    await withTransaction(async conn => {
      // Atomic single-use claim: only one request can flip used=FALSE→TRUE.
      const [claim] = await conn.query(
        'UPDATE password_reset_tokens SET used=TRUE WHERE token=? AND used=FALSE AND expires_at > NOW()',
        [tokenHash]
      );
      if ((claim as { affectedRows?: number }).affectedRows !== 1) {
        const err = new Error('Invalid or expired token');
        (err as { status?: number }).status = 400;
        throw err;
      }
      const [rows] = await conn.query('SELECT user_id FROM password_reset_tokens WHERE token=?', [
        tokenHash,
      ]);
      const row = (rows as Array<{ user_id: string }>)[0];
      if (!row) {
        const err = new Error('Invalid or expired token');
        (err as { status?: number }).status = 400;
        throw err;
      }
      // Invalidate every other unused reset token for this user.
      await conn.query(
        'UPDATE password_reset_tokens SET used=TRUE WHERE user_id=? AND token<>? AND used=FALSE',
        [row.user_id, tokenHash]
      );
      const hash = await bcrypt.hash(validPassword, 12);
      await conn.query('UPDATE users SET password_hash=?, password_changed_at=NOW() WHERE id=?', [
        hash,
        row.user_id,
      ]);
    });
  } catch (error) {
    if ((error as { status?: number }).status === 400) {
      res.status(400).json({ error: (error as Error).message || 'Invalid or expired token' });
      return;
    }
    throw error;
  }
  res.json({ ok: true });
});

export default router;
