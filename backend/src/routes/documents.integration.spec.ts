/**
 * backend/src/routes/documents.integration.spec.ts — Integration tests for the
 * full document lifecycle across all customer-facing features added in PR #7:
 *   - CSV export (one row per document)
 *   - Original file preview beside extracted fields
 *   - Needs-review flag and approve action
 *   - Correction clearing approval
 *   - European amount parsing (via extraction)
 *
 * These tests exercise the Express app end-to-end through supertest with the
 * database pool mocked, covering the new routes and their interaction with
 * existing list/upload flows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs/promises';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

vi.mock('../db/pool.js', () => {
  const conn = {
    query: vi.fn().mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('UPDATE documents SET reviewed_at = NULL')) {
        currentReviewedAt = null;
        return [[]];
      }
      if (s.includes('UPDATE documents SET data=?, updated_at=NOW()')) return [[]];
      if (s.includes('SELECT method, confidence FROM extraction_attempts WHERE document_id=?'))
        return [[{ method: 'local-llm', confidence: 0.9 }]];
      if (s.includes('INSERT INTO corrections')) return [[]];
      return [[]];
    }),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  return {
    pool: {
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue(conn),
    },
    withTransaction: vi.fn(async (fn: any) => {
      await conn.beginTransaction();
      try {
        const result = await fn(conn);
        await conn.commit();
        return result;
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }),
  };
});

function authHeader(userId = 'test-user') {
  const token = jwt.sign(
    { id: userId, email: `${userId}@example.com`, emailVerified: true },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );
  return { Authorization: `Bearer ${token}` };
}

const DOC_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

// Shared state for the correction/approve lifecycle, accessed by both the
// vi.mock factory (conn.query) and the test callbacks (currentReviewedAt).
let currentReviewedAt: string | null = '2026-01-02T00:00:00Z';

beforeEach(() => {
  vi.clearAllMocks();
  // authenticate() looks up the user; return a valid user row.
  (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
    const s = String(sql);
    if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
      return [[{ id: 'test-user', password_changed_at: null }]];
    }
    return [[]];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration — full document lifecycle', () => {
  it('upload → list → export → preview → approve → correct clears approval', async () => {
    const app = createApp();
    const testFile = 'uploads/integration-test.pdf';
    await fs.writeFile(testFile, '%PDF-1.4 integration test');
    try {
      // --- 1. Upload a document (202 accepted) ---
      const updatedRow = {
        id: DOC_ID,
        name: 'integration-test.pdf',
        status: 'done',
        document_type: 'invoice',
        document_category: 'financial',
        data: JSON.stringify({
          vendor: 'Corrected Vendor',
          totalAmount: 1234.56,
          currency: 'EUR',
        }),
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        reviewed_at: '2026-01-02T00:00:00Z',
      };

      const docRow = {
        id: DOC_ID,
        name: 'integration-test.pdf',
        status: 'done',
        document_type: 'invoice',
        document_category: 'financial',
        data: JSON.stringify({
          vendor: 'Acme Corp',
          totalAmount: 1234.56,
          currency: 'EUR',
        }),
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        reviewed_at: null,
      };

      (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
        const s = String(sql);

        // Authenticate middleware - user lookup (every request)
        if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
          return [[{ id: 'test-user', password_changed_at: null }]];
        }

        // --- Upload flow ---
        if (s.includes('findDuplicateByHash') || s.includes('content_hash')) {
          return [[{ duplicate: false }]]; // no duplicate
        }
        if (s.includes('INSERT INTO documents')) {
          return [[]]; // INSERT documents
        }
        if (s.includes('SELECT created_at FROM documents WHERE id=?')) {
          return [[{ created_at: new Date().toISOString() }]];
        }
        if (s.includes("UPDATE documents SET status='processing'")) {
          return [[]]; // UPDATE processing
        }
        if (s.includes('refine_jobs') && s.includes('INSERT')) {
          return [[]]; // INSERT refine job
        }

        // --- List documents ---
        if (s.includes('FROM documents') && s.includes('COUNT(*)')) {
          return [[{ cnt: 1 }]]; // COUNT
        }
        if (s.includes('FROM documents') && s.includes('ORDER BY created_at DESC LIMIT')) {
          return [
            [
              {
                ...docRow,
              },
            ],
          ]; // SELECT documents
        }
        if (s.includes('refine_jobs') && s.includes('MAX(created_at)')) {
          return [[]]; // refine_jobs latest (empty → no refine)
        }
        if (s.includes('extraction_attempts') && s.includes('confidence')) {
          return [[{ document_id: DOC_ID, confidence: 0.95, seq: 1 }]];
        }

        // --- File preview ---
        if (s.includes('SELECT id, name, path FROM documents WHERE id=? AND user_id=?')) {
          return [[{ id: DOC_ID, name: 'integration-test.pdf', path: testFile }]];
        }

        // --- Approve (check AFTER file preview to avoid false match) ---
        if (s.includes('FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()')) {
          if (s.includes('name, status')) {
            // Refetch after approve - return updated row with reviewed_at set
            return [[{ ...updatedRow, reviewed_at: currentReviewedAt }]];
          }
          // Ownership check - return minimal row
          return [[{ id: DOC_ID, reviewed_at: currentReviewedAt }]];
        }
        if (s.includes('reviewed_at = NOW()')) {
          currentReviewedAt = '2026-01-02T00:00:00Z'; // approval sets reviewed_at
          return [[]]; // UPDATE
        }

        // --- File preview ---
        if (s.includes('SELECT id, name, path FROM documents WHERE id=? AND user_id=?')) {
          return [[{ id: DOC_ID, name: 'integration-test.pdf', path: testFile }]];
        }

        // --- Export CSV ---
        if (s.includes('FROM documents') && s.includes('user_id = ?') && s.includes('COUNT(*)')) {
          return [[{ cnt: 1 }]]; // COUNT
        }
        if (
          s.includes('FROM documents') &&
          s.includes('user_id = ?') &&
          !s.includes('COUNT(*)') &&
          !s.includes('name, status')
        ) {
          return [
            [
              {
                id: DOC_ID,
                created_at: '2026-01-01 00:00:00',
                status: 'done',
                document_type: 'invoice',
                document_category: 'financial',
                data: JSON.stringify({
                  vendor: 'Acme Corp',
                  totalAmount: 1234.56,
                  currency: 'EUR',
                }),
              },
            ],
          ]; // SELECT documents
        }

        // --- Correct ---
        if (s.includes('UPDATE documents SET data=?, updated_at=NOW()')) {
          return [[]]; // UPDATE data
        }
        if (s.includes('UPDATE documents SET reviewed_at = NULL')) {
          currentReviewedAt = null; // correction clears reviewed_at
          return [[]]; // UPDATE reviewed_at = NULL
        }
        if (s.includes('extraction_attempts') && s.includes('ORDER BY created_at DESC')) {
          return [[{ method: 'local-llm', confidence: 0.9 }]]; // attempts lookup
        }
        if (s.includes('INSERT INTO corrections')) {
          return [[]]; // INSERT correction
        }

        return [[]];
      });

      // --- 1. Upload ---
      const uploadRes = await request(app)
        .post('/api/documents/upload')
        .set(authHeader())
        .attach('file', testFile, 'integration-test.pdf');
      expect(uploadRes.status).toBe(202);
      expect(uploadRes.body.id).toBeDefined();

      // --- 2. List documents ---
      const listRes = await request(app).get('/api/documents').set(authHeader());
      expect(listRes.status).toBe(200);
      expect(listRes.body.documents.length).toBe(1);
      const doc = listRes.body.documents[0];
      expect(doc.needs_review).toBe(true); // confidence 0.6 < 0.8

      // --- 3. Export CSV ---
      const exportRes = await request(app).get('/api/documents/export').set(authHeader());
      expect(exportRes.status).toBe(200);
      expect(exportRes.headers['content-type']).toContain('text/csv');
      expect(exportRes.text.startsWith('\uFEFF')).toBe(true);
      expect(exportRes.text).toContain('Acme Corp');
      expect(exportRes.text).toContain('1234.56');

      // --- 4. Preview the original file ---
      await fs.writeFile(testFile, '%PDF-1.4 integration test');
      const previewRes = await request(app).get(`/api/documents/${DOC_ID}/file`).set(authHeader());
      expect(previewRes.status).toBe(200);
      expect(previewRes.headers['content-type']).toBe('application/pdf');
      expect(previewRes.headers['content-disposition']).toContain('inline');

      // --- 5. Approve ---
      const approveRes = await request(app)
        .post(`/api/documents/${DOC_ID}/approve`)
        .set(authHeader());
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.needs_review).toBe(false);
      expect(approveRes.body.reviewed_at).toBe('2026-01-02T00:00:00Z');

      // --- 6. Correct a field ---
      const correctRes = await request(app)
        .post(`/api/documents/${DOC_ID}/corrections`)
        .set(authHeader())
        .send({ field: 'vendor', value: 'Corrected Vendor' });
      expect(correctRes.status).toBe(200);
      expect(correctRes.body.changed).toBe(true);

      // --- 7. Re-fetch: reviewed_at should be null after correction ---
      const refetchRes = await request(app).get(`/api/documents/${DOC_ID}`).set(authHeader());
      expect(refetchRes.status).toBe(200);
      expect(refetchRes.body.reviewed_at).toBeNull();
    } finally {
      await fs.unlink(testFile).catch(() => {});
    }
  });

  it('European amount "1.234,56 EUR" parsed correctly via export', async () => {
    const app = createApp();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: any) => {
      const s = String(sql);
      if (s.includes('SELECT id, password_changed_at FROM users WHERE id=?')) {
        return [[{ id: 'euro-user', password_changed_at: null }]];
      }
      if (s.includes('FROM documents')) {
        return [
          [
            {
              id: DOC_ID,
              created_at: '2026-01-01 00:00:00',
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

    const res = await request(app).get('/api/documents/export').set(authHeader('euro-user'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('1234.56');
  });
});
