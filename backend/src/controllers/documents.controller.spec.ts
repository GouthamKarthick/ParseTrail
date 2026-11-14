import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  default: { readFile: vi.fn(), unlink: vi.fn() },
}));
vi.mock('../db/pool.js', () => {
  const conn = {
    query: vi.fn(),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  return {
    pool: {
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValue(conn),
    },
    withTransaction: vi.fn(async fn => {
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
vi.mock('../services/extraction.service.js', () => ({
  extract: vi.fn(),
  recordAttempts: vi.fn(),
}));
vi.mock('../services/dedup.service.js', () => ({
  findDuplicateByHash: vi.fn(),
  createContentFingerprint: vi.fn(() => 'fingerprint'),
}));
vi.mock('../utils/conversion.js', () => ({
  convertWithMeta: vi.fn(),
  applyConversion: vi.fn(),
  clearConversion: vi.fn(),
}));

import { pool } from '../db/pool.js';
import fs from 'fs/promises';
import { extract } from '../services/extraction.service.js';
import { findDuplicateByHash } from '../services/dedup.service.js';
import {
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  getAttempts,
  correctField,
  listCorrections,
  correctionStats,
} from './documents.controller.js';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('controller — uploadDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('%PDF-1.4\nstub') as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(findDuplicateByHash).mockResolvedValue({ duplicate: false } as any);
  });

  it('400 when no file', async () => {
    const res = mockRes();
    await uploadDocument(
      { user: { id: 'test-user', email: 'test@example.com' } } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('queues extraction and returns 202 without extracting inline', async () => {
    const mockQuery = vi.mocked(pool.query);
    // INSERT pending, SELECT created_at (via pool.query); UPDATE processing +
    // enqueue SELECT/INSERT (via connection query inside withTransaction)
    mockQuery
      .mockResolvedValueOnce([[]] as any) // INSERT documents
      .mockResolvedValueOnce([[{ created_at: new Date().toISOString() }]] as any); // SELECT created_at
    const conn = await pool.getConnection();
    vi.mocked(conn.query)
      .mockResolvedValueOnce([[]] as any) // UPDATE processing
      .mockResolvedValueOnce([[]] as any) // enqueue: SELECT existing refine jobs
      .mockResolvedValueOnce([[]] as any); // enqueue: INSERT refine job

    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      file: {
        filename: '550e8400-e29b-41d4-a716-446655440000-test.pdf',
        originalname: 'test.pdf',
        path: '/tmp/test',
        mimetype: 'application/pdf',
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), status: 'pending' })
    );
    expect(extract).not.toHaveBeenCalled();
    expect(fs.readFile).toHaveBeenCalledOnce();
    expect(findDuplicateByHash).toHaveBeenCalledTimes(1);
  });

  it('exact-hash duplicate short-circuits before insert, returns 409', async () => {
    vi.mocked(findDuplicateByHash).mockResolvedValue({
      duplicate: true,
      duplicateOf: 'existing-id',
      matchedDocumentType: 'invoice',
      matchedCategory: 'financial',
      matchedData: { totalAmount: 10 },
    } as any);
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      file: {
        filename: '550e8400-e29b-41d4-a716-446655440000-dup.pdf',
        originalname: 'dup.pdf',
        path: '/tmp/dup',
        mimetype: 'application/pdf',
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'DUPLICATE_UPDATED',
        duplicateOf: 'existing-id',
      })
    );
    expect(extract).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/dup');
  });

  it('short-circuits exact byte duplicates before extraction', async () => {
    vi.mocked(findDuplicateByHash).mockResolvedValue({
      duplicate: true,
      duplicateOf: 'existing-id',
      matchedDocumentType: 'invoice',
      matchedCategory: 'financial',
      matchedData: { totalAmount: 10 },
    } as any);
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      file: {
        filename: 'server-generated-name.pdf',
        originalname: 'same.pdf',
        path: '/tmp/same',
        mimetype: 'application/pdf',
      },
    };
    const res = mockRes();

    await uploadDocument(req, res, vi.fn());

    expect(extract).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/same');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        duplicateOf: 'existing-id',
        document_type: 'invoice',
        data: { totalAmount: 10 },
      })
    );
  });

  it('mismatched magic-byte signature returns 400 and unlinks the file', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('not-a-pdf-contents') as any);
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      file: {
        filename: 'bad.pdf',
        originalname: 'bad.pdf',
        path: '/tmp/bad',
        mimetype: 'application/pdf',
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_FILE_CONTENT' })
    );
    expect(extract).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/bad');
  });

  it('empty file returns 400 and unlinks', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.alloc(0) as any);
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      file: {
        filename: 'empty.pdf',
        originalname: 'empty.pdf',
        path: '/tmp/empty',
        mimetype: 'application/pdf',
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(extract).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/empty');
  });

  it('unlinks the file when the DB insert fails', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('%PDF-1.4\nstub') as any);
    const mockQuery = vi.mocked(pool.query);
    mockQuery.mockRejectedValueOnce(new Error('disk full')); // INSERT fails
    const conn = await pool.getConnection();
    vi.mocked(conn.query).mockResolvedValue([[]] as any); // not reached, but safe
    const next = vi.fn();
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      file: {
        filename: 'boom.pdf',
        originalname: 'boom.pdf',
        path: '/tmp/boom',
        mimetype: 'application/pdf',
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/boom');
  });

  it('rolls back and unlinks when enqueueRefineJob fails', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('%PDF-1.4\nstub') as any);
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([[]] as any) // INSERT documents
      .mockResolvedValueOnce([[{ created_at: new Date().toISOString() }]] as any); // SELECT created_at
    const conn = await pool.getConnection();
    vi.mocked(conn.query)
      .mockResolvedValueOnce([[]] as any) // UPDATE processing
      .mockResolvedValueOnce([[]] as any) // enqueue: SELECT existing refine jobs
      .mockRejectedValueOnce(new Error('enqueue failed')); // enqueue: INSERT fails → rollback
    const next = vi.fn();
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      file: {
        filename: 'boom2.pdf',
        originalname: 'boom2.pdf',
        path: '/tmp/boom2',
        mimetype: 'application/pdf',
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith('/tmp/boom2');
  });
});

describe('controller — listDocuments / getDocument', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listDocuments handles q escape and document_type filter', async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([[{ cnt: 1 }]] as any)
      .mockResolvedValueOnce([[{ id: 'a', name: 'x', data: null }]] as any)
      .mockResolvedValueOnce([[]] as any);
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      query: {},
      _pagination: {
        limit: 10,
        offset: 0,
        q: '100%_test',
        document_type: ['invoice'],
      },
    };
    const res: any = { json: vi.fn() };
    await listDocuments(req, res, vi.fn());
    expect(mockQuery).toHaveBeenCalled();
    const countSql = mockQuery.mock.calls[0][0] as unknown as string;
    expect(countSql).toContain('name LIKE ?');
    expect(countSql).toContain('document_type IN (?)');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ total: 1 }));
  });

  it('listDocuments supports multiple document_types', async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([[{ cnt: 2 }]] as any)
      .mockResolvedValueOnce([[{ id: 'a', name: 'x', data: null }]] as any)
      .mockResolvedValueOnce([[]] as any);
    const req: any = {
      user: { id: 'test-user', email: 'test@example.com' },
      query: {},
      _pagination: {
        limit: 10,
        offset: 0,
        document_type: ['invoice', 'receipt'],
      },
    };
    const res: any = { json: vi.fn() };
    await listDocuments(req, res, vi.fn());
    const countSql = mockQuery.mock.calls[0][0] as unknown as string;
    const countParams = mockQuery.mock.calls[0][1] as unknown as unknown[];
    expect(countSql).toContain('document_type IN (?,?)');
    expect(countParams).toContain('invoice');
    expect(countParams).toContain('receipt');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ total: 2 }));
  });

  it('getDocument 400 invalid uuid', async () => {
    const res = mockRes();
    await getDocument(
      {
        params: { id: 'bad' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('getDocument 404 when not found', async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const res = mockRes();
    await getDocument(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('getDocument 200 returns parsed data', async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'x',
          data: JSON.stringify({ vendor: 'V' }),
          status: 'done',
        },
      ],
    ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await getDocument(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { vendor: 'V' } }));
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('path');
  });

  describe('controller — deleteDocument', () => {
    beforeEach(() => vi.clearAllMocks());

    it('400 invalid uuid', async () => {
      const res = mockRes();
      await deleteDocument(
        {
          params: { id: 'bad' },
          user: { id: 'test-user', email: 'test@example.com' },
        } as any,
        res,
        vi.fn()
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 when document not found for user', async () => {
      vi.mocked(pool.query).mockResolvedValue([[]] as any);
      const res = mockRes();
      await deleteDocument(
        {
          params: { id: '550e8400-e29b-41d4-a716-446655440000' },
          user: { id: 'test-user', email: 'test@example.com' },
        } as any,
        res,
        vi.fn()
      );
      expect(res.status).toHaveBeenCalledWith(404);
      expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
    });

    it('204 deletes row and unlinks file', async () => {
      vi.mocked(pool.query)
        .mockResolvedValueOnce([[{ path: '/tmp/test.pdf' }]] as any) // SELECT path
        .mockResolvedValueOnce([] as any); // DELETE
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      const res = mockRes();
      await deleteDocument(
        {
          params: { id: '550e8400-e29b-41d4-a716-446655440000' },
          user: { id: 'test-user', email: 'test@example.com' },
        } as any,
        res,
        vi.fn()
      );
      expect(res.status).toHaveBeenCalledWith(204);
      expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith('/tmp/test.pdf');
    });

    it('204 ignores ENOENT when unlinking missing file', async () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      vi.mocked(pool.query)
        .mockResolvedValueOnce([[{ path: '/tmp/missing.pdf' }]] as any) // SELECT path
        .mockResolvedValueOnce([] as any); // DELETE
      vi.mocked(fs.unlink).mockRejectedValue(enoent);
      const res = mockRes();
      await deleteDocument(
        {
          params: { id: '550e8400-e29b-41d4-a716-446655440000' },
          user: { id: 'test-user', email: 'test@example.com' },
        } as any,
        res,
        vi.fn()
      );
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('idempotent: second delete returns 404', async () => {
      vi.mocked(pool.query).mockResolvedValue([[]] as any); // no row
      const res = mockRes();
      await deleteDocument(
        {
          params: { id: '550e8400-e29b-41d4-a716-446655440000' },
          user: { id: 'test-user', email: 'test@example.com' },
        } as any,
        res,
        vi.fn()
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 for foreign user (ownership enforced, never 403)', async () => {
      vi.mocked(pool.query).mockResolvedValue([[]] as any); // no row for this user
      const res = mockRes();
      await deleteDocument(
        {
          params: { id: '550e8400-e29b-41d4-a716-446655440000' },
          user: { id: 'other-user', email: 'other@example.com' },
        } as any,
        res,
        vi.fn()
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  it('getAttempts 401 when unauthenticated', async () => {
    const res = mockRes();
    await getAttempts(
      { params: { id: '550e8400-e29b-41d4-a716-446655440000' } } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('getAttempts 400 invalid uuid', async () => {
    const res = mockRes();
    await getAttempts(
      {
        params: { id: 'bad' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('getAttempts 404 when document not found', async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const res = mockRes();
    await getAttempts(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('reprocessDocument 200 re-runs local and enqueues when incomplete', async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([
        [{ id: '550e8400-e29b-41d4-a716-446655440000', path: '/tmp/x.pdf' }],
      ] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any);
    vi.mocked(extract).mockResolvedValue({
      data: { vendor: 'V' },
      confidence: 0.3,
      method: 'rule-based',
      documentType: 'invoice',
      documentTypeConfidence: 0.8,
      documentCategory: 'financial',
      attempts: [],
      typeVotes: ['invoice'],
    } as any);
    const { reprocessDocument } = await import('./documents.controller.js');
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await reprocessDocument(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done', enqueued: true })
    );
  });

  it('reprocessDocument 404 when missing', async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const { reprocessDocument } = await import('./documents.controller.js');
    const res = mockRes();
    await reprocessDocument(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('correctField 400 on unknown field', async () => {
    const res = mockRes();
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: { field: 'hacker', value: 'x' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('correctField 400 on invalid totalAmount', async () => {
    const res = mockRes();
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: { field: 'totalAmount', value: 'abc' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('correctField 404 when missing', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce([[]] as any);
    const res = mockRes();
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: { field: 'totalAmount', value: 100 },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('correctField 200 updates field and logs history', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce([
      [
        {
          id: 'd1',
          data: JSON.stringify({ vendor: 'V', totalAmount: 1850 }),
        },
      ],
    ] as any);
    const conn = await pool.getConnection();
    const mockConnQuery = vi.mocked(conn.query);
    mockConnQuery
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[{ method: 'local-llm', confidence: 0.7 }]] as any)
      .mockResolvedValueOnce([[]] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: { field: 'totalAmount', value: 1580 },
      } as any,
      res,
      vi.fn()
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        field: 'totalAmount',
        original: 1850,
        corrected: 1580,
        changed: true,
      })
    );
    const updateCall = mockConnQuery.mock.calls.find(c =>
      String(c[0]).includes('UPDATE documents SET data=')
    );
    expect(JSON.stringify(updateCall![1])).toContain('1580');
    const insertCall = mockConnQuery.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO corrections')
    );
    expect(insertCall).toBeDefined();
  });

  it('correctField reports unchanged when value matches', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce([
      [{ id: 'd1', data: JSON.stringify({ vendor: 'V' }) }],
    ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: { field: 'vendor', value: 'V' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ changed: false }));
  });

  it('correctField 400 when body missing field', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce([
      [{ id: 'd1', data: JSON.stringify({ vendor: 'V' }) }],
    ] as any);
    const res = mockRes();
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: { value: 100 },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('correctField 400 when body missing value', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce([
      [{ id: 'd1', data: JSON.stringify({ vendor: 'V' }) }],
    ] as any);
    const res = mockRes();
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: { field: 'totalAmount' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('correctField 400 when body is not an object', async () => {
    const res = mockRes();
    await correctField(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
        body: 'not-an-object',
      } as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('listCorrections 200 returns history', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce([[{ id: 'd1' }]] as any)
      .mockResolvedValueOnce([
        [
          {
            field: 'totalAmount',
            original_value: '1850',
            corrected_value: '1580',
          },
        ],
      ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await listCorrections(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'u1', email: 't@e.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ corrections: expect.any(Array) })
    );
  });

  it('correctionStats 200 aggregates', async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await correctionStats({ user: { id: 'u1', email: 't@e.com' } } as any, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        byField: expect.any(Array),
        byType: expect.any(Array),
        byMethod: expect.any(Array),
      })
    );
  });

  it('getAttempts 200 returns attempt rows in order', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce([[{ id: 'doc-1' }]] as any)
      .mockResolvedValueOnce([
        [
          {
            method: 'heuristic-detect',
            confidence: 0.85,
            latency_ms: 0,
            cost_estimate: 0,
            succeeded: 1,
            fallback_reason: null,
            created_at: '2026-09-24',
          },
          {
            method: 'rule-based',
            confidence: 0.68,
            latency_ms: 3,
            cost_estimate: 0,
            succeeded: 1,
            fallback_reason: null,
            created_at: '2026-09-24',
          },
        ],
      ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await getAttempts(
      {
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'test-user', email: 'test@example.com' },
      } as any,
      res,
      vi.fn()
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: expect.arrayContaining([expect.objectContaining({ method: 'rule-based' })]),
      })
    );
  });
});
