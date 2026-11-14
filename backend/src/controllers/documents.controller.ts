/**
 * controllers/documents.controller.ts — Document upload, listing, and export handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { isSuspicious } from '../utils/security.js';
import { extract } from '../services/extraction.service.js';
import { isValidDate } from '../services/confidence.service.js';
import { normalizeCurrency } from '../utils/currency.js';
import { parseAmount } from '../utils/amount.js';
import { applyConversion, clearConversion } from '../utils/conversion.js';
import { parseJsonColumn } from '../utils/json.js';
import { enqueueRefineJob, retryRefineJobNow } from '../jobs/refine.js';
import { findDuplicateByContent, findDuplicateByHash } from '../services/dedup.service.js';
import { uuidSchema } from '../middleware/validate.js';
import { getUser } from '../middleware/auth.js';
import { getSummary as getSummaryData } from '../services/summary.service.js';
import { generateSummaryPdf, generateSummaryCsv } from '../services/export.service.js';

/**
 * Parses JSON data field from DB row.
 * @param row DB row with data string
 * @returns Parsed data or null
 */
function parseDataField(row: { data: string | null }) {
  return parseJsonColumn<Record<string, unknown> | null>(row.data, null);
}

/**
 * Returns the latest refine job status for a document, if any.
 * @param docId Document id
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

type ExtractOutcome = NonNullable<Awaited<ReturnType<typeof extract>>>;

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
  const user = getUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded. Field name must be 'file'." });
    return;
  }
  if (isSuspicious(file.originalname)) {
    // Multer already wrote the file to disk; remove it before rejecting.
    try {
      await fs.unlink(file.path);
    } catch {
      // ignore - file may already be gone
    }
    res.status(400).json({
      error: 'Suspicious file name detected — not saved',
      code: 'SUSPICIOUS_INPUT',
    });
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
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const pagination = (req as unknown as Record<string, unknown>)._pagination as
      | {
          limit: number;
          offset: number;
          q?: string;
          document_type?: string[];
          document_category?: string;
        }
      | undefined;
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
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }
    const [rows] = await pool.query(
      'SELECT id, name, status, document_type, document_category, data, error, created_at, updated_at, expires_at FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()',
      [id, user.id]
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const refine = await latestRefineStatus(parsed.data, user.id);
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
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }
    // Fetch the row + path first so we can unlink the file after deletion.
    // Ownership is enforced in the WHERE clause; a missing or foreign row
    // yields 404 (never 403) to avoid leaking existence.
    const [rows] = await pool.query(
      'SELECT path FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()',
      [parsed.data, user.id]
    );
    const row = (rows as Array<{ path: string }>)[0];
    if (!row) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    await pool.query('DELETE FROM documents WHERE id=?', [parsed.data]);
    // Best-effort unlink of the uploaded file; ignore ENOENT (already gone).
    try {
      await fs.unlink(row.path);
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
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }
    const [docs] = await pool.query(
      'SELECT id FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()',
      [id, user.id]
    );
    if (!(docs as Array<unknown>)[0]) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const [rows] = await pool.query(
      'SELECT method, predicted_type, confidence, latency_ms, cost_estimate, input_tokens, output_tokens, succeeded, fallback_reason, created_at FROM extraction_attempts WHERE document_id=? ORDER BY created_at ASC, id ASC',
      [id]
    );
    res.json({ attempts: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * Reprocess a document: enqueues a background refine job instead of running
 * extraction inline, so uploads stay fast and user corrections are never lost
 * (the worker re-applies them via withCorrectionsReapplied).
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function reprocessDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }
    const [rows] = await pool.query(
      'SELECT id, path FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()',
      [id, user.id]
    );
    const row = (rows as Array<{ id: string; path: string }>)[0];
    if (!row) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    await pool.query("UPDATE documents SET status='processing', error=NULL WHERE id=?", [
      parsed.data,
    ]);
    await enqueueRefineJob(parsed.data, user.id, 'reprocess');
    res.status(202).json({
      id: parsed.data,
      status: 'processing',
      enqueued: true,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Immediately retries cloud refinement for an owned completed document.
 */
export async function retryDocumentRefinement(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }
    const [rows] = await pool.query(
      'SELECT id, status FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()',
      [parsed.data, user.id]
    );
    const doc = (rows as Array<{ id: string; status: string }>)[0];
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    if (doc.status !== 'done') {
      res.status(409).json({ error: 'Only completed documents can be refined' });
      return;
    }
    const status = await retryRefineJobNow(doc.id, user.id);
    if (status === 'working') {
      res.status(409).json({ error: 'Refinement is already in progress' });
      return;
    }
    res.status(202).json({ id: doc.id, status, enqueued: true });
  } catch (err) {
    next(err);
  }
}

// Converted fields are derived, never directly correctable.
const CORRECTABLE_FIELDS = [
  'vendor',
  'invoiceNumber',
  'invoiceDate',
  'totalAmount',
  'currency',
] as const;

/**
 * Validates a correction request body: field must be one of the correctable
 * fields, value is required.
 */
const correctionSchema = z.object({
  field: z.enum(CORRECTABLE_FIELDS),
  value: z.unknown(),
});

/**
 * Validates and normalizes a user-supplied correction value.
 * @param field Field name
 * @param value Raw value
 * @returns Normalized value or null when invalid
 */
function normalizeCorrection(field: string, value: unknown): string | number | null {
  if (field === 'totalAmount') {
    const n = parseAmount(value);
    return n != null && n >= 0 ? n : null;
  }
  if (field === 'invoiceDate') {
    const s = String(value ?? '').trim();
    return isValidDate(s) ? s : null;
  }
  if (field === 'currency') return normalizeCurrency(value);
  const s = String(value ?? '')
    .trim()
    .slice(0, 500);
  return s ? s : null;
}

/**
 * Records a user correction: updates the stored field and logs history.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function correctField(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }
    const parsedBody = correctionSchema.safeParse(req.body);
    if (!parsedBody.success) {
      const issue = parsedBody.error.issues[0];
      res.status(400).json({
        error: `Invalid ${String(issue?.path?.[0] ?? 'body')}: ${issue?.message ?? 'invalid'}`,
      });
      return;
    }
    const { field, value: rawValue } = parsedBody.data;
    const value = normalizeCorrection(field, rawValue);
    if (value == null) {
      res.status(400).json({ error: `Invalid value for ${field}` });
      return;
    }
    const [rows] = await pool.query(
      'SELECT id, data FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()',
      [parsed.data, user.id]
    );
    const row = (rows as Array<{ id: string; data: string | null }>)[0];
    if (!row) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const data: Record<string, unknown> = parseJsonColumn<Record<string, unknown>>(
      row.data as string,
      {}
    );
    const original = data[field] ?? null;
    if (original === value) {
      res.json({
        id: parsed.data,
        field,
        original,
        corrected: value,
        changed: false,
      });
      return;
    }
    data[field] = value;
    if (field === 'totalAmount' || field === 'currency') {
      clearConversion(data);
      try {
        await applyConversion(data);
      } catch {
        logger.warn('Correction FX recompute failed, leaving unconverted', {
          docId: parsed.data,
        });
      }
    }

    // UPDATE documents.data and INSERT corrections atomically so a crash
    // cannot leave corrected data without a correction history record.
    let method: string | null = null;
    let confidence: number | null = null;
    await withTransaction(async conn => {
      await conn.query('UPDATE documents SET data=?, updated_at=NOW() WHERE id=?', [
        JSON.stringify(data),
        parsed.data,
      ]);
      const [arows] = await conn
        .query(
          'SELECT method, confidence FROM extraction_attempts WHERE document_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
          [parsed.data]
        )
        .catch(error => {
          logger.warn('Correction extraction-method lookup failed', {
            docId: parsed.data,
            error: error instanceof Error ? error.message : String(error),
          });
          return [[], []];
        });
      const last = (arows as Array<{ method: string; confidence: number }>)[0];
      if (last) {
        method = last.method;
        confidence = Number(last.confidence);
      }
      await conn.query(
        'INSERT INTO corrections (id, document_id, user_id, field, original_value, corrected_value, extraction_method, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          randomUUID(),
          parsed.data,
          user.id,
          field,
          original == null ? null : String(original),
          String(value),
          method,
          confidence,
        ]
      );
    });
    res.json({
      id: parsed.data,
      field,
      original,
      corrected: value,
      changed: true,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Lists correction history for a document.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function listCorrections(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document id' });
      return;
    }
    const [docs] = await pool.query(
      'SELECT id FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()',
      [parsed.data, user.id]
    );
    if (!(docs as Array<unknown>)[0]) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const [rows] = await pool.query(
      'SELECT field, original_value, corrected_value, extraction_method, confidence, created_at FROM corrections WHERE document_id=? ORDER BY created_at DESC',
      [parsed.data]
    );
    res.json({ corrections: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * Aggregates correction stats: which fields and types get corrected most.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function correctionStats(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const [byField] = await pool.query(
      'SELECT field, COUNT(*) AS cnt FROM corrections WHERE user_id=? GROUP BY field ORDER BY cnt DESC',
      [user.id]
    );
    const [byType] = await pool.query(
      'SELECT d.document_type, COUNT(*) AS cnt FROM corrections c JOIN documents d ON d.id=c.document_id WHERE c.user_id=? GROUP BY d.document_type ORDER BY cnt DESC',
      [user.id]
    );
    const [byMethod] = await pool.query(
      "SELECT COALESCE(extraction_method,'unknown') AS method, COUNT(*) AS cnt FROM corrections WHERE user_id=? GROUP BY method ORDER BY cnt DESC",
      [user.id]
    );
    res.json({ byField, byType, byMethod });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns summary aggregation.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function getSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const category =
      typeof req.query.category === 'string'
        ? req.query.category
        : typeof req.query.document_category === 'string'
          ? req.query.document_category
          : undefined;
    const summary = await getSummaryData(user.id, 30, category ? { category } : undefined);
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

/**
 * Exports summary as PDF or CSV.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function exportSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const format = String(req.query.format || 'pdf').toLowerCase();
    const category =
      typeof req.query.category === 'string'
        ? req.query.category
        : typeof req.query.document_category === 'string'
          ? req.query.document_category
          : undefined;
    if (format === 'csv') {
      const csv = await generateSummaryCsv(user.id, category);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=parsetrail-summary-${new Date().toISOString().slice(0, 10)}.csv`
      );
      res.send(csv);
      return;
    }
    const pdf = await generateSummaryPdf(user.id, category);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=parsetrail-summary-${new Date().toISOString().slice(0, 10)}.pdf`
    );
    res.send(pdf);
  } catch (err) {
    next(err);
  }
}
