/**
 * services/dedup.service.ts — Duplicate document detection.
 */

import { pool } from "../db/pool.js";
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
): Promise<{
  duplicate: boolean;
  duplicateOf?: string;
  matchedData?: ExtractedData;
}> {
  const r = newData as Record<string, unknown>;
  const av = normVendor(r.vendor as string | undefined);
  const ai = normInvoiceNo(r.invoiceNumber as string | undefined);
  const at = normTotal(r.totalAmount as number | undefined);
  const ac = normCurrency(r.currency as string | undefined);
  if (!av || !ai || at == null || !ac) return { duplicate: false };
  const type =
    (docTypeHint || (r.documentType as string) || "").toLowerCase() ||
    "invoice";
  const where = userId
    ? "WHERE status='done' AND data IS NOT NULL AND user_id=? AND document_type=? AND expires_at > NOW() LIMIT 200"
    : "WHERE status='done' AND data IS NOT NULL AND document_type=? AND expires_at > NOW() LIMIT 200";
  const params = userId ? [userId, type] : [type];
  const [rows] = await pool.query(
    `SELECT id, data, document_type FROM documents ${where}`,
    params,
  );
  for (const r2 of rows as Array<{
    id: string;
    data: string;
    document_type: string;
  }>) {
    const d = parseJsonColumn<ExtractedData | null>(r2.data as string, null);
    if (!d) continue;
    if (isDuplicateContent(newData, d))
      return { duplicate: true, duplicateOf: r2.id, matchedData: d };
  }
  return { duplicate: false };
}
