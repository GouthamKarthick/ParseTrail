/**
 * services/dedup.service.ts — Duplicate document detection.
 */

import { pool } from "../db/pool.js";
import { createHash } from "crypto";
import type { ExtractedData } from "../types/index.js";
import { normalizeCurrency } from "../utils/currency.js";
import { parseJsonColumn } from "../utils/json.js";

/**
 * Normalizes vendor string.
 * @param v Vendor
 * @returns Normalized vendor
 */
function normVendor(v?: string): string | null {
  if (!v) return null;
  return v.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Normalizes invoice number.
 * @param v Invoice number
 * @returns Normalized invoice number
 */
function normInvoiceNo(v?: string): string | null {
  if (!v) return null;
  return v.trim().toUpperCase();
}

/**
 * Normalizes currency via the shared mapper (symbols and codes).
 * @param v Currency
 * @returns Normalized currency
 */
function normCurrency(v?: string): string | null {
  if (!v) return null;
  return normalizeCurrency(v);
}

/**
 * Normalizes total amount.
 * @param v Amount
 * @returns Normalized amount
 */
function normTotal(v?: number): number | null {
  if (v == null || isNaN(v)) return null;
  return Number(Number(v).toFixed(2));
}

export function createContentFingerprint(
  data: ExtractedData,
  docType: string,
): string | null {
  const fields = data as Record<string, unknown>;
  const vendor = normVendor(fields.vendor as string | undefined);
  const invoiceNumber = normInvoiceNo(
    fields.invoiceNumber as string | undefined,
  );
  const totalAmount = normTotal(fields.totalAmount as number | undefined);
  const currency = normCurrency(fields.currency as string | undefined);
  if (!vendor || !invoiceNumber || totalAmount == null || !currency)
    return null;
  const normalized = JSON.stringify([
    docType.toLowerCase(),
    vendor,
    invoiceNumber,
    totalAmount,
    currency,
  ]);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Checks if two extracted datasets represent duplicate documents.
 * @param a First dataset
 * @param b Second dataset
 * @returns True if duplicates
 */
function isDuplicateContent(a: ExtractedData, b: ExtractedData): boolean {
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const av = normVendor(ar.vendor as string | undefined);
  const bv = normVendor(br.vendor as string | undefined);
  const ai = normInvoiceNo(ar.invoiceNumber as string | undefined);
  const bi = normInvoiceNo(br.invoiceNumber as string | undefined);
  const at = normTotal(ar.totalAmount as number | undefined);
  const bt = normTotal(br.totalAmount as number | undefined);
  const ac = normCurrency(ar.currency as string | undefined);
  const bc = normCurrency(br.currency as string | undefined);
  if (!av || !bv || !ai || !bi || at == null || bt == null || !ac || !bc)
    return false;
  return av === bv && ai === bi && at === bt && ac === bc;
}

/**
 * Finds duplicate document by content for a user/type.
 * @param newData New extracted data
 * @param userId Optional user id
 * @param docTypeHint Optional type hint
 * @returns Duplicate result
 */
export async function findDuplicateByContent(
  newData: ExtractedData,
  userId?: string,
  docTypeHint?: string,
  options?: { contentHash?: string; excludeDocumentId?: string },
): Promise<{
  duplicate: boolean;
  duplicateOf?: string;
  matchedData?: ExtractedData;
  matchedDocumentType?: string;
  matchedCategory?: string;
}> {
  const type =
    (docTypeHint || (newData as Record<string, unknown>).documentType || "")
      .toString()
      .toLowerCase() || "invoice";
  const ownerClause = userId ? "user_id=? AND " : "";
  const ownerParams = userId ? [userId] : [];
  const excludeClause = options?.excludeDocumentId ? "AND id<>? " : "";
  const excludeParams = options?.excludeDocumentId
    ? [options.excludeDocumentId]
    : [];
  /**
   * Returns the first row whose parsed data matches newData, skipping rows
   * whose data column is not valid JSON.
   */
  function findMatchInRows(
    rows: Array<{
      id: string;
      data: string | null;
      document_type: string;
      document_category: string;
    }>,
  ): {
    id: string;
    data: ExtractedData;
    document_type: string;
    document_category: string;
  } | undefined {
    for (const r2 of rows) {
      const d = parseJsonColumn<ExtractedData | null>(r2.data as string, null);
      if (!d) continue;
      if (isDuplicateContent(newData, d))
        return {
          id: r2.id,
          data: d,
          document_type: r2.document_type,
          document_category: r2.document_category,
        };
    }
    return undefined;
  }

  if (options?.contentHash) {
    const [hashRows] = await pool.query(
      `SELECT id, data, document_type, document_category FROM documents WHERE ${ownerClause}content_hash=? AND status IN ('pending','processing','done') AND expires_at > NOW() ${excludeClause}ORDER BY created_at DESC, id DESC LIMIT 1`,
      [...ownerParams, options.contentHash, ...excludeParams],
    );
    const match = findMatchInRows(
      hashRows as Array<{
        id: string;
        data: string | null;
        document_type: string;
        document_category: string;
      }>,
    );
    if (match)
      return {
        duplicate: true,
        duplicateOf: match.id,
        matchedData: match.data,
        matchedDocumentType: match.document_type,
        matchedCategory: match.document_category,
      };
  }

  const fingerprint = createContentFingerprint(newData, type);
  if (fingerprint) {
    const [fingerprintRows] = await pool.query(
      `SELECT id, data, document_type, document_category FROM documents WHERE ${ownerClause}content_fingerprint=? AND document_type=? AND status='done' AND expires_at > NOW() ${excludeClause}ORDER BY created_at DESC, id DESC LIMIT 1`,
      [...ownerParams, fingerprint, type, ...excludeParams],
    );
    const match = findMatchInRows(
      fingerprintRows as Array<{
        id: string;
        data: string | null;
        document_type: string;
        document_category: string;
      }>,
    );
    if (match)
      return {
        duplicate: true,
        duplicateOf: match.id,
        matchedData: match.data,
        matchedDocumentType: match.document_type,
        matchedCategory: match.document_category,
      };
  }

  const r = newData as Record<string, unknown>;
  const av = normVendor(r.vendor as string | undefined);
  const ai = normInvoiceNo(r.invoiceNumber as string | undefined);
  const at = normTotal(r.totalAmount as number | undefined);
  const ac = normCurrency(r.currency as string | undefined);
  if (!av || !ai || at == null || !ac) return { duplicate: false };
  const where = userId
    ? "WHERE status='done' AND data IS NOT NULL AND user_id=? AND document_type=? AND expires_at > NOW()"
    : "WHERE status='done' AND data IS NOT NULL AND document_type=? AND expires_at > NOW()";
  const params = userId ? [userId, type] : [type];
  const excludeIdFilter = options?.excludeDocumentId ? " AND id<>?" : "";
  if (options?.excludeDocumentId) params.push(options.excludeDocumentId);
  const [rows] = await pool.query(
    `SELECT id, data, document_type, document_category FROM documents ${where}${excludeIdFilter} ORDER BY created_at DESC, id DESC LIMIT 200`,
    params,
  );
  const match = findMatchInRows(
    rows as Array<{
      id: string;
      data: string | null;
      document_type: string;
      document_category: string;
    }>,
  );
  if (match)
    return {
      duplicate: true,
      duplicateOf: match.id,
      matchedData: match.data,
      matchedDocumentType: match.document_type,
      matchedCategory: match.document_category,
    };
  return { duplicate: false };
}
