/**
 * utils/confidence.ts — Centralized confidence scoring for extraction attempts.
 *
 * Provides a consistent confidence formula used across the extraction cascade:
 *   confidence = min(1, filled_fields / 5) * 0.85
 * Where filled_fields is the count of non-null extracted fields (vendor, invoiceNumber,
 * invoiceDate, totalAmount, currency). The 0.85 base accounts for rule-based certainty,
 * and the /5 scales linearly from 0 (0/5) to 1 (5/5).
 *
 * A separate variant with 0.5 base is used for local LLM fallbacks where confidence
 * is inherently lower due to model stochasticity.
 */
export function ruleBasedConfidence(filled: number): number {
  return Math.min(1, filled / 5) * 0.85;
}

export function localLlmConfidence(filled: number): number {
  return Math.min(1, filled / 5) * 0.5;
}
