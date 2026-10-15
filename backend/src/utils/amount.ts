/**
 * utils/amount.ts — Single amount parser (replaces 3 copy-pasted
 * scrub-and-Number blocks in ai/transformers/controller).
 */

/**
 * Parses a localized amount string to a number.
 * @param raw Raw value (number passed through when finite)
 * @returns Finite number or null
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const n = Number(raw.replace(/[,₹$€£\s]|Rs\.?/gi, ""));
  return isNaN(n) ? null : n;
}
