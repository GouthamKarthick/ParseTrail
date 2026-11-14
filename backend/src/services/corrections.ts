/**
 * services/corrections.ts — Correction re-application.
 * Re-applies recorded user corrections over freshly extracted data so
 * duplicate re-uploads and reprocessing never clobber human fixes.
 */

import { pool } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { applyConversion, clearConversion } from '../utils/conversion.js';

/**
 * Re-applies recorded user corrections over freshly extracted data so
 * duplicate re-uploads and reprocessing never clobber human fixes.
 * @param docId Document id holding the corrections
 * @param data Freshly extracted data
 * @returns Data with corrections re-applied
 */
export async function withCorrectionsReapplied(
  docId: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    const [rows] = await pool.query(
      'SELECT field, corrected_value FROM corrections WHERE document_id=? ORDER BY created_at ASC',
      [docId]
    );
    const list = rows as Array<{
      field: string;
      corrected_value: string | null;
    }>;
    if (list.length === 0) return data;
    const merged: Record<string, unknown> = { ...data };
    let financialAmountCorrected = false;
    for (const c of list) {
      if (c.corrected_value == null) continue;
      if (c.field === 'totalAmount') {
        const n = Number(c.corrected_value);
        merged[c.field] = isFinite(n) ? n : c.corrected_value;
        financialAmountCorrected = true;
      } else {
        merged[c.field] = c.corrected_value;
        if (c.field === 'currency') financialAmountCorrected = true;
      }
    }
    if (financialAmountCorrected) {
      clearConversion(merged);
      try {
        await applyConversion(merged);
      } catch {
        logger.warn('Reapplied-correction FX recompute failed', { docId });
      }
    }
    return merged;
  } catch (e) {
    logger.warn('Corrections lookup failed, using uncorrected data', {
      docId,
      error: (e as Error).message,
    });
    return data;
  }
}
