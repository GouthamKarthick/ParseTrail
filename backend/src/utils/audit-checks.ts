/**
 * utils/audit-checks.ts — Cross-document financial guardrails.
 *
 * Zero new tables, zero AI calls, zero migrations. Reads the user's own
 * existing `documents` rows and attaches alert objects (possible
 * duplicate, amount spike, payslip shift, future date) that surface in
 * the UI and force the document into the needs-review set.
 */

import { pool } from '../db/pool.js';
import { findDuplicateByContent } from '../services/dedup.service.js';
import { parseJsonColumn } from './json.js';
import type { ExtractedData } from '../types/index.js';

export interface Alert {
  code: 'POSSIBLE_DUPLICATE' | 'AMOUNT_SPIKE' | 'PAYSLIP_SHIFT' | 'FUTURE_DATE';
  message: string;
  relatedDocId?: string;
}

function normVendor(v?: string): string | null {
  if (!v) return null;
  return v.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

function normTotal(v?: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Number(Number(v).toFixed(2));
}

function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function money(n: number | null | undefined, currency?: string | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sym =
    currency === 'INR'
      ? '₹'
      : currency === 'USD'
        ? '$'
        : currency === 'EUR'
          ? '€'
          : (currency ?? '');
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Runs every alert check for a freshly extracted / merged document and
 * returns the alerts to attach to `data`. None of these block extraction.
 * @param newData Extracted data for the current document
 * @param userId Owner id
 * @param docType Document type
 * @param documentId Current document id (excluded from self-matches)
 * @returns Alerts array (may be empty)
 */
export async function checkDocumentAlerts(
  newData: ExtractedData,
  userId: string,
  docType: string,
  documentId: string
): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const r = newData as Record<string, unknown>;
  const vendor = normVendor(r.vendor as string | undefined);
  const total = normTotal(r.totalAmount as number | undefined);
  const invoiceDate = parseDate(r.invoiceDate as string | undefined);
  const currency = String(r.currency ?? '');

  // --- 1. Exact content duplicate (vendor + invoiceNo + amount + currency) ---
  let exactDupId: string | undefined;
  try {
    const dup = await findDuplicateByContent(newData as ExtractedData, userId, docType, {
      excludeDocumentId: documentId,
    });
    if (dup.duplicate && dup.duplicateOf) {
      exactDupId = dup.duplicateOf;
      alerts.push({
        code: 'POSSIBLE_DUPLICATE',
        relatedDocId: dup.duplicateOf,
        message: `Possible duplicate — matches ${money(total, currency)} ${dup.matchedDocumentType ?? docType} from ${r.vendor ?? 'a vendor'} uploaded earlier`,
      });
    }
  } catch {
    // Non-fatal: a dedup lookup failure must never block extraction.
  }

  // --- 2. Loose fallback: same vendor + same amount within ±14 days ---
  // Only runs when Step 1 found no exact content duplicate, so the same
  // document never fires POSSIBLE_DUPLICATE twice.
  if (!exactDupId && vendor && total != null) {
    try {
      const [rows] = await pool.query(
        `SELECT id, data, created_at FROM documents
         WHERE user_id=? AND document_type=? AND status='done' AND id<>? AND expires_at > NOW()
           AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
         ORDER BY created_at DESC LIMIT 200`,
        [userId, docType, documentId]
      );
      const refDate = invoiceDate ?? new Date();
      for (const row of rows as Array<{
        id: string;
        data: string | null;
        created_at?: string;
      }>) {
        if (row.id === exactDupId) continue;
        const d = parseJsonColumn<Record<string, unknown>>(row.data as string, {});
        if (!d) continue;
        if (normVendor(d.vendor as string | undefined) !== vendor) continue;
        if (normTotal(d.totalAmount as number | undefined) !== total) continue;
        const otherDate =
          parseDate(d.invoiceDate as string | undefined) ??
          parseDate(row.created_at as string | undefined);
        if (
          otherDate &&
          Math.abs(otherDate.getTime() - refDate.getTime()) <= 14 * 24 * 60 * 60 * 1000
        ) {
          alerts.push({
            code: 'POSSIBLE_DUPLICATE',
            relatedDocId: row.id,
            message: `Possible duplicate — same ${money(total, currency)} from ${r.vendor ?? 'a vendor'} within 14 days (invoice ${d.invoiceNumber ?? 'no number'})`,
          });
          break;
        }
      }
    } catch {
      // Non-fatal.
    }
  }

  // --- 3. Vendor amount spike (>30% above historical average) ---
  if (vendor && total != null && (docType === 'bill' || docType === 'invoice')) {
    try {
      const [rows] = await pool.query(
        `SELECT data FROM documents
         WHERE user_id=? AND document_type=? AND status='done' AND id<>? AND expires_at > NOW()
           AND data IS NOT NULL
         ORDER BY created_at DESC LIMIT 50`,
        [userId, docType, documentId]
      );
      const prior: number[] = [];
      for (const row of rows as Array<{ data: string | null }>) {
        const d = parseJsonColumn<Record<string, unknown>>(row.data as string, {});
        if (!d) continue;
        if (normVendor(d.vendor as string | undefined) !== vendor) continue;
        // Skip cross-currency rows — a 100 USD bill must not spike against 8,500 INR bills.
        const dCurrency = String(d.currency ?? '');
        if (currency && dCurrency && dCurrency.toUpperCase() !== currency.toUpperCase()) continue;
        const t = normTotal(d.totalAmount as number | undefined);
        if (t != null) prior.push(t);
        if (prior.length >= 5) break;
      }
      if (prior.length >= 2) {
        const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
        const pct = ((total - avg) / avg) * 100;
        if (pct > 30) {
          alerts.push({
            code: 'AMOUNT_SPIKE',
            message: `${pct > 0 ? '+' : ''}${pct.toFixed(0)}% higher than your ${money(avg, currency)} average for this vendor`,
          });
        }
      }
    } catch {
      // Non-fatal.
    }
  }

  // --- 4. Payslip net-pay shift (>5% vs latest prior payslip) ---
  if (vendor && total != null && docType === 'payslip') {
    try {
      const [rows] = await pool.query(
        `SELECT data FROM documents
         WHERE user_id=? AND document_type='payslip' AND status='done' AND id<>? AND expires_at > NOW()
           AND data IS NOT NULL
         ORDER BY created_at DESC LIMIT 20`,
        [userId, documentId]
      );
      let prev: number | null = null;
      for (const row of rows as Array<{ data: string | null }>) {
        const d = parseJsonColumn<Record<string, unknown>>(row.data as string, {});
        if (!d) continue;
        if (normVendor(d.vendor as string | undefined) !== vendor) continue;
        const dCurrency = String(d.currency ?? '');
        if (currency && dCurrency && dCurrency.toUpperCase() !== currency.toUpperCase()) continue;
        prev = normTotal(d.totalAmount as number | undefined) ?? null;
        break;
      }
      if (prev != null && prev !== 0) {
        const pct = ((total - prev) / prev) * 100;
        if (Math.abs(pct) > 5) {
          alerts.push({
            code: 'PAYSLIP_SHIFT',
            message: `Net pay shifted ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs. your previous payslip`,
          });
        }
      }
    } catch {
      // Non-fatal.
    }
  }

  // --- 5. Date sanity: invoiceDate > 7 days in the future ---
  if (invoiceDate) {
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    if (invoiceDate > sevenDaysLater) {
      alerts.push({
        code: 'FUTURE_DATE',
        message: `Invoice date is more than 7 days in the future (${r.invoiceDate})`,
      });
    }
  }

  return alerts;
}
