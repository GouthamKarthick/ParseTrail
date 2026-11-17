import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs/promises';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { logger } from '../config/logger.js';

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

  const DOC_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  it('GET /api/documents/:id/file 200 with the right content type for an owned doc', async () => {
    const app = createApp();
    const testFile = 'uploads/preview-test.pdf';
    await fs.writeFile(testFile, '%PDF-1.4 test');
    try {
      (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
        const s = String(sql);
        if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
          return [[{ id: 'test-user', password_changed_at: null }]];
        }
        if (s.includes('FROM documents WHERE id=? AND user_id=?')) {
          return [[{ id: DOC_ID, name: 'preview-test.pdf', path: testFile }]];
        }
        return [[]];
      });

      const res = await request(app).get(`/api/documents/${DOC_ID}/file`).set(authHeader());
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toContain('no-store');
    } finally {
      await fs.unlink(testFile).catch(() => {});
    }
  });

  it('GET /api/documents/:id/file 404 for another user\u2019s doc', async () => {
    const app = createApp();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'other-user', password_changed_at: null }]];
      }
      if (s.includes('FROM documents WHERE id=? AND user_id=?')) {
        return [[]];
      }
      return [[]];
    });

    const res = await request(app).get(`/api/documents/${DOC_ID}/file`).set(authHeader());
    expect(res.status).toBe(404);
  });

  it('GET /api/documents/:id/file 404 when the stored file is missing', async () => {
    const app = createApp();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'test-user', password_changed_at: null }]];
      }
      if (s.includes('FROM documents WHERE id=? AND user_id=?')) {
        return [[{ id: DOC_ID, name: 'missing.pdf', path: 'uploads/missing-test.pdf' }]];
      }
      return [[]];
    });

    const res = await request(app).get(`/api/documents/${DOC_ID}/file`).set(authHeader());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Original file is no longer available');
  });

  it('GET /api/documents/:id/file 404 when the stored path is outside the upload dir', async () => {
    const app = createApp();
    const warn = vi.spyOn(logger, 'warn');
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'test-user', password_changed_at: null }]];
      }
      if (s.includes('FROM documents WHERE id=? AND user_id=?')) {
        return [[{ id: DOC_ID, name: 'evil.pdf', path: '/etc/passwd' }]];
      }
      return [[]];
    });

    const res = await request(app).get(`/api/documents/${DOC_ID}/file`).set(authHeader());
    expect(res.status).toBe(404);
    expect(warn).toHaveBeenCalledWith(
      'Original file path outside upload directory',
      expect.objectContaining({ documentId: DOC_ID })
    );
    warn.mockRestore();
  });

  it('POST /api/documents/:id/approve 200 sets reviewed_at and returns needs_review false', async () => {
    const app = createApp();
    const updatedRow = {
      id: DOC_ID,
      name: 'x.pdf',
      status: 'done',
      document_type: 'invoice',
      document_category: 'financial',
      data: JSON.stringify({ vendor: 'V', totalAmount: 1850 }),
      error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      reviewed_at: '2026-01-02T00:00:00Z',
    };
    let approveCallCount = 0;
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'test-user', password_changed_at: null }]];
      }
      if (s.includes('FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()')) {
        approveCallCount++;
        if (approveCallCount === 1) {
          // First call: ownership check returns minimal fields
          return [[{ id: DOC_ID, reviewed_at: null }]];
        }
        // Second call: refetch returns full updated row
        return [[updatedRow]];
      }
      if (s.includes('reviewed_at = NOW()')) {
        return [[]];
      }
      if (s.includes('extraction_attempts')) {
        return [[{ confidence: 0.95 }]];
      }
      if (s.includes('refine_jobs')) {
        return [[]];
      }
      return [[]];
    });

    const res = await request(app).post(`/api/documents/${DOC_ID}/approve`).set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.needs_review).toBe(false);
    expect(res.body.reviewed_at).toBe('2026-01-02T00:00:00Z');
  });

  it('POST /api/documents/:id/approve 404 for another user', async () => {
    const app = createApp();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'other-user', password_changed_at: null }]];
      }
      if (s.includes('FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()')) {
        return [[]];
      }
      return [[]];
    });

    const res = await request(app).post(`/api/documents/${DOC_ID}/approve`).set(authHeader());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Document not found');
  });

  it('POST /api/documents/:id/approve 401 without a user', async () => {
    const app = createApp();
    // Origin header bypasses CSRF check so authenticate middleware returns 401.
    const res = await request(app)
      .post(`/api/documents/${DOC_ID}/approve`)
      .set('Origin', config.corsOrigins[0]);
    expect(res.status).toBe(401);
  });
});
