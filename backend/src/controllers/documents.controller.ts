/**
 * controllers/documents.controller.ts — Document upload, listing, get, delete, and attempts handlers.
 *
 * Correction, refinement, and summary handlers have been split into their own
 * modules (corrections.controller.ts, refine.controller.ts, summary.controller.ts)
 * and are re-exported here for backward compatibility.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import { pool, withTransaction } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { parseJsonColumn } from '../utils/json.js';
import { extractDocumentData } from '../services/extraction.service.js';
import { enqueueRefineJob } from '../jobs/refine.js';
import { findDuplicateByContent, findDuplicateByHash } from '../services/dedup.service.js';

// ---------------------------------------------------------------------------
// Re-exports from split controller modules
// ---------------------------------------------------------------------------

export { reprocessDocument, retryDocumentRefinement } from './refine.controller.js';
export { correctField, listCorrections, correctionStats } from './corrections.controller.js';
export { getSummary, exportSummary } from './summary.controller.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses JSON data field from DB row. Handles both string (raw JSON text)
 * and object (already parsed by mysql2 JSON column type) cases.
 * @param row DB row with data field
 * @returns Parsed data or null
 */
function parseDataField(row: { data: string | null | Record<string, unknown> }) {
  return parseJsonColumn<Record<string, unknown> | null>(row.data, null);
}

/**
 * Fetches a document by id and owner, sending 404 if not found.
 * Ownership is enforced in the WHERE clause; a missing or foreign row
 * yields 404 (never 403) to avoid leaking existence.
 * @param id Document id (UUID)
 * @param userId Owner user id
 * @param res Express response
 * @param select Optional SQL select fragment (default: all document columns)
 * @returns Document row or null (response already sent when null)
 */
export async function findDocumentByIdAndUser(
  id: string,
  userId: string,
  res: Response,
  select = 'id, name, status, document_type, document_category, data, error, created_at, updated_at, expires_at'
) {
  const [rows] = await pool.query(
    `SELECT ${select} FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()`,
    [id, userId]
  );
  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) {
    res.status(404).json({ error: 'Document not found' });
    return null;
  }
  return row;
}

/**
 * Returns the latest refine job status for a document, if any.
 * @param docId Document id
 * @param userId Owner id
 * @returns Status or null
 */
async function latestRefineStatus(
  docId: string,
  userId: string
): Promise<{ status: string | null; error: string | null }> {
  const [rows] = await pool.query(
    'SELECT status, error FROM refine_jobs WHERE document_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1',
    [docId, userId]
  );
  const row = (rows as Array<{ status: string; error: string | null }>)[0];
  return { status: row?.status ?? null, error: row?.error ?? null };
}

// ---------------------------------------------------------------------------
// Document handlers
// ---------------------------------------------------------------------------

type ExtractOutcome = NonNullable<Awaited<ReturnType<typeof extractDocumentData>>>;

function respondDuplicate(
  res: Response,
  duplicate: Awaited<ReturnType<typeof findDuplicateByContent>>,
  result?: ExtractOutcome,
  updated = false
): void {
  res.status(409).json({
    error: updated
      ? 'Duplicate document — updated existing record'
      : 'Duplicate document — already exists',
    code: 'DUPLICATE_UPDATED',
    duplicateOf: duplicate.duplicateOf,
    document_type: result?.documentType ?? duplicate.matchedDocumentType ?? 'unknown',
    document_category: result?.documentCategory ?? duplicate.matchedCategory ?? 'unknown',
    data: result?.data ?? duplicate.matchedData ?? {},
  });
}

/**
 * Handles document upload, extraction, and dedup.
 * Sync path is local-only (fast); incomplete results enqueue background
 * cloud refinement instead of blocking the response on Gemini.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function uploadDocument(req: Request, res: Response, next: NextFunction) {
  const user = req.user!;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded. Field name must be 'file'." });
    return;
  }

  const filePath = file.path;
  let uploadSucceeded = false;
  try {
    const buffer = await fs.readFile(filePath);
    const header = buffer.subarray(0, 8);
    const isPdf = header.subarray(0, 4).toString('latin1') === '%PDF';
    const isPng = header[0] === 0x89 && header.subarray(1, 4).toString('latin1') === 'PNG';
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const expectedType = file.mimetype;
    const signatureMatches =
      (expectedType === 'application/pdf' && isPdf) ||
      (expectedType === 'image/png' && isPng) ||
      ((expectedType === 'image/jpeg' || expectedType === 'image/jpg') && isJpeg);
    // Always require the magic-byte signature to match (no empty-header bypass).
    if (!signatureMatches) {
      res.status(400).json({
        error: 'File contents do not match the uploaded file type',
        code: 'INVALID_FILE_CONTENT',
      });
      return;
    }
    const id = randomUUID();
    const contentHash = createHash('sha256').update(buffer).digest('hex');
    const exactDuplicate = await findDuplicateByHash(user.id, contentHash);
    if (exactDuplicate.duplicate && exactDuplicate.duplicateOf) {
      respondDuplicate(res, exactDuplicate);
      return;
    }

    try {
      await pool.query(
        "INSERT INTO documents (id, name, path, status, document_type, document_category, user_id, content_hash) VALUES (?, ?, ?, 'pending', 'unknown', 'unknown', ?, ?)",
        [id, file.originalname, filePath, user.id, contentHash]
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        const duplicate = await findDuplicateByHash(user.id, contentHash);
        if (duplicate.duplicate && duplicate.duplicateOf) {
          respondDuplicate(res, duplicate);
          return;
        }
      }
      throw error;
    }
    const [createdRows] = await pool.query('SELECT created_at FROM documents WHERE id=?', [id]);
    const created_at =
      (createdRows as Array<{ created_at: string }>)[0]?.created_at ?? new Date().toISOString();
    logger.info('Document uploaded', {
      docId: id,
      name: file.originalname,
      path: filePath,
    });

    // Mark processing and enqueue the refine job atomically so a crash cannot
    // leave a 'processing' row with no background job.
    await withTransaction(async conn => {
      await conn.query("UPDATE documents SET status='processing' WHERE id=?", [id]);
      await enqueueRefineJob(id, user.id, 'initial extraction', conn);
    });
    logger.info('Extraction queued', { docId: id });

    // Extraction runs in the background worker so uploads stay fast even for
    // large scanned PDFs. The frontend polls /api/documents/:id until the
    // status reaches done / failed / dead.
    uploadSucceeded = true;
    res.status(202).json({
      id,
      name: file.originalname,
      status: 'pending',
      created_at,
    });
  } catch (err) {
    logger.error('Upload failed', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    next(err);
  } finally {
    // Multer wrote the file to disk; remove it on every failed path so a
    // rejected or errored upload never leaves an orphan file behind.
    if (!uploadSucceeded) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('Failed to unlink uploaded file on error path', {
            path: filePath,
            error: (error as Error).message,
          });
        }
      }
    }
  }
}

/**
 * Lists documents for current user.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function listDocuments(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const pagination = req._pagination;
    const limit = pagination?.limit ?? Number(req.query.limit ?? 20);
    const offset = pagination?.offset ?? Number(req.query.offset ?? 0);
    const q = pagination?.q?.trim() || undefined;
    const docTypes = (pagination?.document_type ?? []).filter(Boolean);
    const docCat =
      pagination?.document_category || (req.query.document_category as string | undefined);
    const where: string[] = ['user_id = ?', 'expires_at > NOW()'];
    const params: unknown[] = [user.id];
    if (q) {
      where.push('name LIKE ?');
      const escaped = q.replace(/[%_\\]/g, '\\$&');
      params.push(`%${escaped}%`);
    }
    if (docTypes.length) {
      where.push(`document_type IN (${docTypes.map(() => '?').join(',')})`);
      params.push(...docTypes);
    }
    if (docCat && ['financial', 'unknown'].includes(docCat)) {
      where.push('document_category = ?');
      params.push(docCat);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM documents ${whereSql}`,
      params
    );
    const total = (totalRows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
    const [rows] = await pool.query(
      `SELECT id, name, status, document_type, document_category, data, error, created_at, updated_at, expires_at FROM documents ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const list = rows as Array<Record<string, unknown>>;
    const refineByDoc: Record<string, { status: string; error: string | null }> = {};
    if (list.length > 0) {
      const ids = list.map(r => r.id as string);
      const placeholders = ids.map(() => '?').join(',');
      const [rrows] = await pool.query(
        `SELECT r.document_id, r.status, r.error FROM refine_jobs r INNER JOIN (SELECT document_id, MAX(created_at) AS mc FROM refine_jobs WHERE document_id IN (${placeholders}) GROUP BY document_id) latest ON latest.document_id = r.document_id AND latest.mc = r.created_at`,
        ids
      );
      for (const r of rrows as Array<{
        document_id: string;
        status: string;
        error: string | null;
      }>)
        refineByDoc[r.document_id] = { status: r.status, error: r.error };
    }
    const documents = list.map(r => ({
      ...r,
      data: parseDataField(r as { data: string | null }),
      refine_status: refineByDoc[r.id as string]?.status ?? null,
      refine_error: refineByDoc[r.id as string]?.error ?? null,
    }));
    res.json({ documents, total, limit, offset });
  } catch (err) {
    next(err);
  }
}

/**
 * Fetches a single document.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function getDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const id = req.parsedId!;
    const row = await findDocumentByIdAndUser(id, user.id, res);
    if (!row) return;
    const refine = await latestRefineStatus(id, user.id);
    res.json({
      ...row,
      data: parseDataField(row as { data: string | null }),
      refine_status: refine.status,
      refine_error: refine.error,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Deletes a document and all its derived records (attempts, corrections,
 * refine jobs cascade via ON DELETE CASCADE), then unlinks the uploaded file.
 * Returns 404 (never 403) when the document does not exist or belongs to
 * another user, to avoid leaking existence. Idempotent: a second delete
 * returns 404.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function deleteDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const id = req.parsedId!;
    const row = await findDocumentByIdAndUser(id, user.id, res, 'path');
    if (!row) return;
    await pool.query('DELETE FROM documents WHERE id=?', [id]);
    try {
      await fs.unlink(row.path as string);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/**
 * Returns per-stage extraction attempts for a document.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function getAttempts(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const id = req.parsedId!;
    const doc = await findDocumentByIdAndUser(id, user.id, res, 'id');
    if (!doc) return;
    const [rows] = await pool.query(
      'SELECT method, predicted_type, confidence, latency_ms, cost_estimate, input_tokens, output_tokens, succeeded, fallback_reason, created_at FROM extraction_attempts WHERE document_id=? ORDER BY created_at ASC, id ASC',
      [id]
    );
    res.json({ attempts: rows });
  } catch (err) {
    next(err);
  }
}
