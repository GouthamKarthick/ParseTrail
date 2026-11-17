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

  it('POST /api/documents/:id/reprocess returns 429 when rate limited', async () => {
    const app = createApp();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      if (String(sql).includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'test-user', password_changed_at: null }]];
      }
      if (
        String(sql).includes(
          'SELECT id, path FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()'
        )
      ) {
        return [[{ id: 'test-doc', path: '/tmp/test.pdf' }]];
      }
      return [[]];
    });

    let status429 = false;
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/api/documents/test-doc/reprocess').set(authHeader());
      if (res.status === 429) {
        status429 = true;
        expect(res.body.code).toBe('RATE_LIMITED');
        break;
      }
    }
    expect(status429).toBe(true);
  });

  it('GET /api/documents/export 200 returns CSV with BOM and header', async () => {
    const app = createApp();
    // Use a distinct user id so the shared expensiveRouteLimit (exhausted by
    // the rate-limit test for 'test-user') does not block this request.
    const token = jwt.sign(
      { id: 'export-user', email: 'export@example.com', emailVerified: true },
      config.jwtSecret,
      { algorithm: 'HS256' }
    );
    const exportAuth = { Authorization: `Bearer ${token}` };
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'export-user', password_changed_at: null }]];
      }
      if (s.includes('FROM documents')) {
        return [
          [
            {
              id: 'test-doc',
              created_at: '2026-11-17 10:00:00',
              status: 'done',
              document_type: 'invoice',
              document_category: 'financial',
              data: JSON.stringify({ vendor: 'Acme', totalAmount: 1234.56 }),
            },
          ],
        ];
      }
      return [[]];
    });

    const res = await request(app).get('/api/documents/export').set(exportAuth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.csv');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    expect(res.text).toContain(
      'id,created_at,document_type,document_category,status,confidence,vendor,invoiceNumber,date,currency,totalAmount,corrected,refine_status'
    );
    expect(res.text).toContain('Acme');
  });

  it('GET /api/documents/export 401 without a user', async () => {
    const app = createApp();
    const res = await request(app).get('/api/documents/export');
    expect(res.status).toBe(401);
  });
});
