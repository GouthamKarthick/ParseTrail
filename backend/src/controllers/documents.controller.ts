/**
 * controllers/documents.controller.ts — Document upload, listing, and export handlers.
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { pool } from "../db/pool.js";
import { logger } from "../config/logger.js";
import { extract, recordAttempts } from "../services/extraction.service.js";
import {
  needsRefinement,
  isValidDate,
} from "../services/confidence.service.js";
import { normalizeCurrency } from "../utils/currency.js";
import { parseAmount } from "../utils/amount.js";
import { applyConversion, clearConversion } from "../utils/conversion.js";
import { parseJsonColumn } from "../utils/json.js";
import { enqueueRefineJob, retryRefineJobNow } from "../jobs/refine.js";
import { findDuplicateByContent } from "../services/dedup.service.js";
import { uuidSchema } from "../middleware/validate.js";
import { getUser } from "../middleware/auth.js";
import { getSummary as getSummaryData } from "../services/summary.service.js";
import {
  generateSummaryPdf,
  generateSummaryCsv,
} from "../services/export.service.js";

/**
 * Parses JSON data field from DB row.
 * @param row DB row with data string
 * @returns Parsed data or null
 */
function parseDataField(row: { data: string | null }) {
  return parseJsonColumn<Record<string, unknown> | null>(row.data, null);
}

/**
 * Checks a finished local result and enqueues cloud refinement if needed.
 * Never throws — refinement is best-effort.
 * @param docId Document id
 * @param userId Owner id
 * @param data Extracted data
 * @param docType Decided type
 * @param attempts Cascade attempts
 * @returns Enqueue reason or null
 */
async function maybeEnqueueRefine(
  docId: string,
  userId: string,
  data: unknown,
  docType: string,
  attempts: Array<{ fallbackReason?: string }> | undefined,
): Promise<string | null> {
  try {
    const { needed, reason } = needsRefinement(
      (data ?? {}) as Record<string, unknown>,
      docType,
      attempts ?? [],
    );
    if (needed && reason) {
      await enqueueRefineJob(docId, userId, reason);
      return reason;
    }
    return null;
  } catch (e) {
    logger.warn("Refine enqueue check failed", { error: (e as Error).message });
    return null;
  }
}

/**
 * Re-applies recorded user corrections over freshly extracted data so
 * duplicate re-uploads and reprocessing never clobber human fixes.
 * @param docId Document id holding the corrections
 * @param data Freshly extracted data
 * @returns Data with corrections re-applied
 */
async function withCorrectionsReapplied(
  docId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const [rows] = await pool.query(
      "SELECT field, corrected_value FROM corrections WHERE document_id=? ORDER BY created_at ASC",
      [docId],
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
      if (c.field === "totalAmount") {
        const n = Number(c.corrected_value);
        merged[c.field] = isFinite(n) ? n : c.corrected_value;
        financialAmountCorrected = true;
      } else {
        merged[c.field] = c.corrected_value;
        if (c.field === "currency") financialAmountCorrected = true;
      }
    }
    if (financialAmountCorrected) {
      clearConversion(merged);
      try {
        await applyConversion(merged);
      } catch {
        logger.warn("Reapplied-correction FX recompute failed", { docId });
      }
    }
    return merged;
  } catch (e) {
    logger.warn("Corrections lookup failed, using uncorrected data", {
      docId,
      error: (e as Error).message,
    });
    return data;
  }
}

/**
 * Returns the latest refine job status for a document, if any.
 * @param docId Document id
 * @returns Status or null
 */
async function latestRefineStatus(
  docId: string,
  userId: string,
): Promise<string | null> {
  const [rows] = await pool.query(
    "SELECT status FROM refine_jobs WHERE document_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1",
    [docId, userId],
  );
  return (rows as Array<{ status: string }>)[0]?.status ?? null;
}

type ExtractOutcome = NonNullable<Awaited<ReturnType<typeof extract>>>;

/**
 * Applies a duplicate re-upload onto the existing record: removes the new
 * file, re-applies corrections, persists, records attempts, maybe enqueues.
 * @param targetId Existing document id
 * @param userId Owner id
 * @param result Fresh extraction result
 * @param filePath New file to delete
 * @param originalName New file name for logs
 * @param deleteId Placeholder row to delete (dup-entry branch), if any
 * @returns void
 */
async function handleDuplicateUpdate(
  targetId: string,
  userId: string,
  result: ExtractOutcome,
  filePath: string,
  originalName: string,
  deleteId?: string,
): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {}
  if (deleteId)
    await pool.query("DELETE FROM documents WHERE id=?", [deleteId]);
  const preserved = await withCorrectionsReapplied(
    targetId,
    result.data as Record<string, unknown>,
  );
  await pool.query(
    "UPDATE documents SET data=?, document_type=?, document_category=?, updated_at=NOW() WHERE id=? AND user_id=?",
    [
      JSON.stringify(preserved),
      result.documentType,
      result.documentCategory,
      targetId,
      userId,
    ],
  );
  await recordAttempts(targetId, result.attempts);
  await maybeEnqueueRefine(
    targetId,
    userId,
    preserved,
    result.documentType,
    result.attempts,
  );
  logger.warn("Duplicate document — updated existing record", {
    duplicateOf: targetId,
    newFile: originalName,
    data: result.data,
  });
}

/**
 * Completes a fresh upload: done/failed write, attempts, refine enqueue.
 * Caller sets status='processing' first (preserves query order).
 * @param docId Document id
 * @param userId Owner id
 * @param result Extraction result or null
 * @param extractError Extraction error or null
 * @returns Terminal status for the response
 */
async function completeUpload(
  docId: string,
  userId: string,
  result: ExtractOutcome | null,
  extractError: string | null,
): Promise<"done" | "failed"> {
  if (extractError || !result) {
    await pool.query(
      "UPDATE documents SET status='failed', error=? WHERE id=?",
      [extractError ?? "Extraction failed", docId],
    );
    logger.error("Extraction failed", { docId, error: extractError });
    return "failed";
  }
  await pool.query(
    "UPDATE documents SET status='done', document_type=?, document_category=?, data=?, error=NULL WHERE id=?",
    [
      result.documentType,
      result.documentCategory,
      JSON.stringify(result.data),
      docId,
    ],
  );
  await recordAttempts(docId, result.attempts);
  await maybeEnqueueRefine(
    docId,
    userId,
    result.data,
    result.documentType,
    result.attempts,
  );
  logger.info("Extraction done", {
    docId,
    method: result.method,
    confidence: result.confidence,
    documentType: result.documentType,
    documentCategory: result.documentCategory,
    documentTypeConfidence: result.documentTypeConfidence,
    data: result.data,
  });
  return "done";
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
export async function uploadDocument(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res
        .status(400)
        .json({ error: "No file uploaded. Field name must be 'file'." });
      return;
    }
    const { isSuspicious } = await import("../utils/security.js");
    if (isSuspicious(file.originalname)) {
      res.status(400).json({
        error: "Suspicious file name detected — not saved",
        code: "SUSPICIOUS_INPUT",
      });
      return;
    }
    const filePath = file.path;
    let result: Awaited<ReturnType<typeof extract>> | null = null;
    let extractError: string | null = null;
    try {
      result = await extract(filePath, { allowCloud: false });
    } catch (e) {
      extractError = (e as Error).message;
      logger.error("Extraction failed before dedup", { error: extractError });
    }
    if (result && !extractError) {
      const dup = await findDuplicateByContent(
        result.data,
        user.id,
        result.documentType as string,
      );
      if (dup.duplicate && dup.duplicateOf) {
        await handleDuplicateUpdate(
          dup.duplicateOf,
          user.id,
          result,
          filePath,
          file.originalname,
        );
        res.status(409).json({
          error: "Duplicate document — updated existing record",
          code: "DUPLICATE_UPDATED",
          duplicateOf: dup.duplicateOf,
          document_type: result.documentType,
          document_category: result.documentCategory,
          data: result.data,
        });
        return;
      }
    }
    const basename = file.filename;
    const idFromFile = basename.split("-")[0] ?? "";
    const id = (() => {
      try {
        uuidSchema.parse(idFromFile);
        return idFromFile;
      } catch {
        return randomUUID();
      }
    })();
    const storedPath = filePath;
    try {
      await pool.query(
        "INSERT INTO documents (id, name, path, status, document_type, document_category, user_id) VALUES (?, ?, ?, 'pending', 'unknown', 'unknown', ?)",
        [id, file.originalname, storedPath, user.id],
      );
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "ER_DUP_ENTRY") {
        const newId = randomUUID();
        await pool.query(
          "INSERT INTO documents (id, name, path, status, document_type, document_category, user_id) VALUES (?, ?, ?, 'pending', 'unknown', 'unknown', ?)",
          [newId, file.originalname, storedPath, user.id],
        );
        const [rows] = await pool.query(
          "SELECT created_at FROM documents WHERE id=?",
          [newId],
        );
        const created_at =
          (rows as Array<{ created_at: string }>)[0]?.created_at ??
          new Date().toISOString();
        let finalResult = result;
        let finalError = extractError;
        if (!finalResult && !finalError) {
          try {
            finalResult = await extract(filePath, { allowCloud: false });
          } catch (err) {
            finalError = (err as Error).message;
          }
        }
        await pool.query(
          "UPDATE documents SET status='processing' WHERE id=?",
          [newId],
        );
        if (finalResult && !finalError) {
          const dup2 = await findDuplicateByContent(
            finalResult.data,
            user.id,
            finalResult.documentType as string,
          );
          if (dup2.duplicate && dup2.duplicateOf) {
            await handleDuplicateUpdate(
              dup2.duplicateOf,
              user.id,
              finalResult,
              filePath,
              file.originalname,
              newId,
            );
            res.status(409).json({
              error: "Duplicate document — updated existing record",
              code: "DUPLICATE_UPDATED",
              duplicateOf: dup2.duplicateOf,
              document_type: finalResult.documentType,
              document_category: finalResult.documentCategory,
              data: finalResult.data,
            });
            return;
          }
        }
        const newStatus = await completeUpload(
          newId,
          user.id,
          finalResult,
          finalError,
        );
        res.status(201).json({
          id: newId,
          name: file.originalname,
          status: newStatus,
          created_at,
        });
        return;
      }
      throw e;
    }
    const [createdRows] = await pool.query(
      "SELECT created_at FROM documents WHERE id=?",
      [id],
    );
    const created_at =
      (createdRows as Array<{ created_at: string }>)[0]?.created_at ??
      new Date().toISOString();
    logger.info("Document uploaded", {
      docId: id,
      name: file.originalname,
      path: storedPath,
    });
    await pool.query("UPDATE documents SET status='processing' WHERE id=?", [
      id,
    ]);
    logger.info("Extraction started", { docId: id });
    const responseStatus = await completeUpload(
      id,
      user.id,
      result,
      extractError,
    );
    res.status(201).json({
      id,
      name: file.originalname,
      status: responseStatus,
      created_at,
    });
  } catch (err) {
    logger.error("Upload failed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    next(err);
  }
}

/**
 * Lists documents for current user.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function listDocuments(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const pagination = (req as unknown as Record<string, unknown>)
      ._pagination as
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
      pagination?.document_category ||
      (req.query.document_category as string | undefined);
    const where: string[] = ["user_id = ?", "expires_at > NOW()"];
    const params: unknown[] = [user.id];
    if (q) {
      where.push("name LIKE ?");
      const escaped = q.replace(/[%_\\]/g, "\\$&");
      params.push(`%${escaped}%`);
    }
    if (docTypes.length) {
      where.push(`document_type IN (${docTypes.map(() => "?").join(",")})`);
      params.push(...docTypes);
    }
    if (docCat && ["financial", "unknown"].includes(docCat)) {
      where.push("document_category = ?");
      params.push(docCat);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM documents ${whereSql}`,
      params,
    );
    const total = (totalRows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
    const [rows] = await pool.query(
      `SELECT id, name, status, document_type, document_category, data, error, created_at, updated_at, expires_at FROM documents ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const list = rows as Array<Record<string, unknown>>;
    const refineByDoc: Record<string, string> = {};
    if (list.length > 0) {
      const ids = list.map((r) => r.id as string);
      const placeholders = ids.map(() => "?").join(",");
      const [rrows] = await pool.query(
        `SELECT r.document_id, r.status FROM refine_jobs r INNER JOIN (SELECT document_id, MAX(created_at) AS mc FROM refine_jobs WHERE document_id IN (${placeholders}) GROUP BY document_id) latest ON latest.document_id = r.document_id AND latest.mc = r.created_at`,
        ids,
      );
      for (const r of rrows as Array<{ document_id: string; status: string }>)
        refineByDoc[r.document_id] = r.status;
    }
    const documents = list.map((r) => ({
      ...r,
      data: parseDataField(r as { data: string | null }),
      refine_status: refineByDoc[r.id as string] ?? null,
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
export async function getDocument(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const [rows] = await pool.query(
      "SELECT id, name, status, document_type, document_category, data, error, created_at, updated_at, expires_at FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()",
      [id, user.id],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (!row) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const refineStatus = await latestRefineStatus(parsed.data, user.id);
    res.json({
      ...row,
      data: parseDataField(row as { data: string | null }),
      refine_status: refineStatus,
    });
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
export async function getAttempts(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const [docs] = await pool.query(
      "SELECT id FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()",
      [id, user.id],
    );
    if (!(docs as Array<unknown>)[0]) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const [rows] = await pool.query(
      "SELECT method, predicted_type, confidence, latency_ms, cost_estimate, succeeded, fallback_reason, created_at FROM extraction_attempts WHERE document_id=? ORDER BY seq ASC",
      [id],
    );
    res.json({ attempts: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * Re-runs local extraction on a document and enqueues cloud refinement.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function reprocessDocument(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const [rows] = await pool.query(
      "SELECT id, path FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()",
      [id, user.id],
    );
    const row = (rows as Array<{ id: string; path: string }>)[0];
    if (!row) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    let result: Awaited<ReturnType<typeof extract>> | null = null;
    try {
      result = await extract(row.path, { allowCloud: false });
    } catch (e) {
      await pool.query(
        "UPDATE documents SET status='failed', error=? WHERE id=?",
        [(e as Error).message.slice(0, 500), id],
      );
      res.json({ id, status: "failed", enqueued: false });
      return;
    }
    const preservedRe = await withCorrectionsReapplied(
      parsed.data,
      result.data as Record<string, unknown>,
    );
    await pool.query(
      "UPDATE documents SET status='done', document_type=?, document_category=?, data=?, error=NULL WHERE id=?",
      [
        result.documentType,
        result.documentCategory,
        JSON.stringify(preservedRe),
        parsed.data,
      ],
    );
    await recordAttempts(parsed.data, result.attempts);
    const reason = await maybeEnqueueRefine(
      parsed.data,
      user.id,
      preservedRe,
      result.documentType,
      result.attempts,
    );
    res.json({
      id: parsed.data,
      status: "done",
      enqueued: reason != null,
      reason,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Immediately retries cloud refinement for an owned completed document.
 */
export async function retryDocumentRefinement(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const [rows] = await pool.query(
      "SELECT id, status FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()",
      [parsed.data, user.id],
    );
    const doc = (rows as Array<{ id: string; status: string }>)[0];
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (doc.status !== "done") {
      res.status(409).json({ error: "Only completed documents can be refined" });
      return;
    }
    const status = await retryRefineJobNow(doc.id, user.id);
    if (status === "working") {
      res.status(409).json({ error: "Refinement is already in progress" });
      return;
    }
    res.status(202).json({ id: doc.id, status, enqueued: true });
  } catch (err) {
    next(err);
  }
}

// Converted fields are derived, never directly correctable.
const CORRECTABLE_FIELDS = [
  "vendor",
  "invoiceNumber",
  "invoiceDate",
  "totalAmount",
  "currency",
] as const;

/**
 * Validates and normalizes a user-supplied correction value.
 * @param field Field name
 * @param value Raw value
 * @returns Normalized value or null when invalid
 */
function normalizeCorrection(
  field: string,
  value: unknown,
): string | number | null {
  if (field === "totalAmount") {
    const n = parseAmount(value);
    return n != null && n >= 0 ? n : null;
  }
  if (field === "invoiceDate") {
    const s = String(value ?? "").trim();
    return isValidDate(s) ? s : null;
  }
  if (field === "currency") return normalizeCurrency(value);
  const s = String(value ?? "")
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
export async function correctField(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const field = String((req.body as { field?: unknown }).field ?? "");
    if (!(CORRECTABLE_FIELDS as readonly string[]).includes(field)) {
      res.status(400).json({
        error: `Field must be one of: ${CORRECTABLE_FIELDS.join(", ")}`,
      });
      return;
    }
    const value = normalizeCorrection(
      field,
      (req.body as { value?: unknown }).value,
    );
    if (value == null) {
      res.status(400).json({ error: `Invalid value for ${field}` });
      return;
    }
    const [rows] = await pool.query(
      "SELECT id, data FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()",
      [parsed.data, user.id],
    );
    const row = (rows as Array<{ id: string; data: string | null }>)[0];
    if (!row) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const data: Record<string, unknown> = parseJsonColumn<
      Record<string, unknown>
    >(row.data as string, {});
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
    if (field === "totalAmount" || field === "currency") {
      clearConversion(data);
      try {
        await applyConversion(data);
      } catch {
        logger.warn("Correction FX recompute failed, leaving unconverted", {
          docId: parsed.data,
        });
      }
    }
    await pool.query(
      "UPDATE documents SET data=?, updated_at=NOW() WHERE id=?",
      [JSON.stringify(data), parsed.data],
    );
    let method: string | null = null;
    let confidence: number | null = null;
    try {
      const [arows] = await pool.query(
        "SELECT method, confidence FROM extraction_attempts WHERE document_id=? ORDER BY seq DESC LIMIT 1",
        [parsed.data],
      );
      const last = (arows as Array<{ method: string; confidence: number }>)[0];
      if (last) {
        method = last.method;
        confidence = Number(last.confidence);
      }
    } catch {}
    await pool.query(
      "INSERT INTO corrections (id, document_id, user_id, field, original_value, corrected_value, extraction_method, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        randomUUID(),
        parsed.data,
        user.id,
        field,
        original == null ? null : String(original),
        String(value),
        method,
        confidence,
      ],
    );
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
export async function listCorrections(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const id = req.params.id;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const [docs] = await pool.query(
      "SELECT id FROM documents WHERE id=? AND user_id=? AND expires_at > NOW()",
      [parsed.data, user.id],
    );
    if (!(docs as Array<unknown>)[0]) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const [rows] = await pool.query(
      "SELECT field, original_value, corrected_value, extraction_method, confidence, created_at FROM corrections WHERE document_id=? ORDER BY created_at DESC",
      [parsed.data],
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
export async function correctionStats(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const [byField] = await pool.query(
      "SELECT field, COUNT(*) AS cnt FROM corrections WHERE user_id=? GROUP BY field ORDER BY cnt DESC",
      [user.id],
    );
    const [byType] = await pool.query(
      "SELECT d.document_type, COUNT(*) AS cnt FROM corrections c JOIN documents d ON d.id=c.document_id WHERE c.user_id=? GROUP BY d.document_type ORDER BY cnt DESC",
      [user.id],
    );
    const [byMethod] = await pool.query(
      "SELECT COALESCE(extraction_method,'unknown') AS method, COUNT(*) AS cnt FROM corrections WHERE user_id=? GROUP BY method ORDER BY cnt DESC",
      [user.id],
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
export async function getSummary(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const category =
      typeof req.query.category === "string"
        ? req.query.category
        : typeof req.query.document_category === "string"
          ? req.query.document_category
          : undefined;
    const summary = await getSummaryData(
      user.id,
      30,
      category ? { category } : undefined,
    );
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
export async function exportSummary(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = getUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const format = String(req.query.format || "pdf").toLowerCase();
    const category =
      typeof req.query.category === "string"
        ? req.query.category
        : typeof req.query.document_category === "string"
          ? req.query.document_category
          : undefined;
    if (format === "csv") {
      const csv = await generateSummaryCsv(user.id, category);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=claritydocs-summary-${new Date().toISOString().slice(0, 10)}.csv`,
      );
      res.send(csv);
      return;
    }
    const pdf = await generateSummaryPdf(user.id, category);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=claritydocs-summary-${new Date().toISOString().slice(0, 10)}.pdf`,
    );
    res.send(pdf);
  } catch (err) {
    next(err);
  }
}
