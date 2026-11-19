/**
 * utils/review.ts — Review-state helpers.
 *
 * Pure, model-free decision rule for whether a document needs a
 * customer check-and-correct pass.
 */

/**
 * Determines whether a document needs review.
 *
 * A document does NOT need review once it has been approved
 * (reviewed_at is set). Otherwise it needs review when:
 *   - confidence < 0.8, or
 *   - any of vendor, date (invoiceDate) or totalAmount is missing or empty
 *     in data, or
 *   - refine_status === 'dead'.
 *
 * A correction after approval clears reviewed_at, which re-enables this
 * rule on the next read.
 *
 * @param doc Document row (with reviewed_at, confidence, data,
 *            refine_status)
 * @returns True when the document needs review
 */
export function needsReview(doc: {
  reviewed_at: Date | string | null;
  confidence: number | null;
  data: Record<string, unknown> | null | undefined;
  refine_status: string | null | undefined;
}): boolean {
  if (doc.reviewed_at) return false;

  if (doc.confidence != null && doc.confidence < 0.8) return true;

  const data = doc.data ?? {};
  const vendor = data.vendor;
  const date = data.invoiceDate ?? data.date;
  const totalAmount = data.totalAmount;

  if (vendor == null || String(vendor).trim() === '') return true;
  if (date == null || String(date).trim() === '') return true;
  if (totalAmount == null || String(totalAmount).trim() === '') return true;

  if (doc.refine_status === 'dead') return true;

  // Only POSSIBLE_DUPLICATE and FUTURE_DATE force human review. Amount
  // spikes and payslip shifts surface as alerts but do not block review.
  const forcedReviewCodes = new Set(['POSSIBLE_DUPLICATE', 'FUTURE_DATE']);
  const rawAlerts = (data as Record<string, unknown>).alerts;
  const alerts = Array.isArray(rawAlerts) ? rawAlerts : null;
  if (alerts?.some((a: Record<string, unknown>) => forcedReviewCodes.has(String(a.code))))
    return true;

  return false;
}
