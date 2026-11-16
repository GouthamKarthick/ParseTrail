/**
 * controllers/corrections.controller.ts — Document field correction handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { isValidDate } from '../services/confidence.service.js';
import { parseJsonColumn } from '../utils/json.js';
import { normalizeCurrency } from '../utils/currency.js';
import { parseAmount } from '../utils/amount.js';
import { applyConversion, clearConversion } from '../utils/conversion.js';
import { findDocumentByIdAndUser } from './documents.controller.js';

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
    const user = req.user!;
    const id = req.parsedId!;
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
    const row = await findDocumentByIdAndUser(id, user.id, res, 'id, data');
    if (!row) return;
    const data: Record<string, unknown> = parseJsonColumn<Record<string, unknown>>(
      row.data as string,
      {}
    );
    const original = data[field] ?? null;
    if (original === value) {
      res.json({
        id,
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
          docId: id,
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
        id,
      ]);
      const [arows] = await conn
        .query(
          'SELECT method, confidence FROM extraction_attempts WHERE document_id=? ORDER BY created_at DESC, id DESC LIMIT 1',
          [id]
        )
        .catch(error => {
          logger.warn('Correction extraction-method lookup failed', {
            docId: id,
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
          id,
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
      id,
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
    const user = req.user!;
    const id = req.parsedId!;
    const row = await findDocumentByIdAndUser(id, user.id, res, 'id');
    if (!row) return;
    const [rows] = await pool.query(
      'SELECT field, original_value, corrected_value, extraction_method, confidence, created_at FROM corrections WHERE document_id=? ORDER BY created_at DESC',
      [id]
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
    const user = req.user!;
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
