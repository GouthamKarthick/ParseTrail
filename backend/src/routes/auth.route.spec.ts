import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';

const mockState = vi.hoisted(() => ({ attempts: 0, calls: [] as unknown[][] }));
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('../db/pool.js', () => ({ pool: { query: mockQuery } }));
vi.mock('../services/email.service.js', () => ({
  sendVerificationEmail: vi.fn(),
  sendResetEmail: vi.fn(),
}));

import authRouter from './auth.route.js';

describe('email verification', () => {
  beforeEach(() => {
    mockState.attempts = 0;
    mockState.calls = [];
    mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
      mockState.calls.push([sql, params]);
      if (String(sql).startsWith('SELECT id, email, verification_code')) {
        if (mockState.attempts >= 5) return [[], []];
        return [
          [
            {
              id: 'user-1',
              email: 'person@example.com',
              verification_code: '123456',
              verification_attempts: mockState.attempts,
            },
          ],
          [],
        ];
      }
      if (String(sql).includes('SET verification_attempts=verification_attempts+1')) {
        mockState.attempts++;
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 1 }, []];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires an email and invalidates a code after five incorrect attempts', async () => {
    const app = express().use(express.json()).use(authRouter);
    const missingEmail = await request(app).post('/verify-email').send({ code: '000000' });
    expect(missingEmail.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();

    const responses = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      responses.push(
        await request(app)
          .post('/verify-email')
          .send({ email: 'person@example.com', code: '000000' })
      );
    }

    expect(responses.slice(0, 4).map(response => response.status)).toEqual([400, 400, 400, 400]);
    expect(responses[4].status).toBe(429);
    expect(responses[4].body.code).toBe('VERIFICATION_CODE_INVALIDATED');
    expect(mockState.attempts).toBe(5);
    expect(mockState.calls[0][1]).toEqual(['person@example.com']);
  });
});

describe('auth route — login timing', () => {
  let compareSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    compareSpy = vi.spyOn(bcrypt, 'compare');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always calls bcrypt.compare even when the email does not exist', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // no such user
    compareSpy.mockResolvedValue(false);

    const app = express().use(express.json()).use(authRouter);
    const res = await request(app)
      .post('/login')
      .send({ email: 'nonexistent@example.com', password: 'Password1!' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });
});
