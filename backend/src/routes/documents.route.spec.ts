import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn() },
}));

function authHeader() {
  const token = jwt.sign(
    {
      id: 'test-user',
      email: 'test@example.com',
      emailVerified: true,
    },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  // authenticate() looks up the user; return a valid user row.
  (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
    if (String(sql).includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
      return [[{ id: 'test-user', password_changed_at: null }]];
    }
    return [[]];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routes — documents', () => {
  it('GET /health → 200 ok', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/documents validates pagination (400 on bad limit)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/documents?limit=9999').set(authHeader());
    expect(res.status).toBe(400);
  });

  it('POST /api/documents/upload 400 when no file', async () => {
    const app = createApp();
    const res = await request(app).post('/api/documents/upload').set(authHeader());
    expect(res.status).toBe(400);
  });

  it('GET /api/documents/:id 400 invalid uuid', async () => {
    const app = createApp();
    const res = await request(app).get('/api/documents/bad-id').set(authHeader());
    expect(res.status).toBe(400);
  });

  it('POST /api/documents/:id/refinement/retry 400 invalid uuid', async () => {
    const app = createApp();
    const res = await request(app).post('/api/documents/bad-id/refinement/retry').set(authHeader());
    expect(res.status).toBe(400);
  });
});
