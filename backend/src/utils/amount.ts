/**
 * utils/amount.ts — Single amount parser (replaces 3 copy-pasted
 * scrub-and-Number blocks in ai/transformers/controller).
 */

/**
 * Parses a localized amount string to a number.
 *
 * Handles European number formats:
 *   - both '.' and ',' present: the one that appears LAST is the decimal
 *     separator; the other is removed as a thousands separator
 *     ("1.234,56" -> 1234.56, "1,234.56" -> 1234.56)
 *   - only ',' present: exactly one comma with 1-2 following digits is a
 *     decimal ("12,50" -> 12.5); otherwise commas are thousands separators
 *     ("1,234" -> 1234, "1,23,456" -> 123456)
 *   - only '.' present: more than one dot means thousands
 *     ("1.234.567" -> 1234567); a single dot stays a decimal point. A lone
 *     dot ("1.234") is ambiguous and follows the "use . for decimals" rule,
 *     so it stays 1.234.
 * @param raw Raw value (number passed through when finite)
 * @returns Finite number or null
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  // 1. Strip currency symbols/words, spaces (incl. NBSP) and apostrophes
  //    (Swiss 1'234.50). Keep digits, one leading minus, comma and dot.
  let s = raw
    .replace(/[₹$€£]/g, '')
    .replace(/\bRs\.?/gi, '') // Rs / Rs. (dot consumed; no trailing \b so "Rs. " matches)
    .replace(/\b(EUR|USD|GBP|CHF|INR|kr|zł)\b/gi, '')
    .replace(/[\s\u00A0\u202F]+/g, '')
    .replace(/['’]/g, '');

  const hasMinus = s.startsWith('-');
  s = s.replace(/[^0-9.,-]/g, '').replace(/-/g, '');
  if (hasMinus) s = '-' + s;

  if (!/[0-9]/.test(s)) return null;

  // 2. Decide the decimal separator.
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    // The separator that appears LAST is the decimal separator.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(/,/, '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    // Only commas: one comma with 1-2 trailing digits is a decimal;
    // otherwise commas are thousands separators.
    if (s.lastIndexOf(',') === s.indexOf(',') && /,\d{1,2}$/.test(s)) {
      s = s.replace(/,/, '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasDot && !hasComma) {
    // Only dots: more than one dot means thousands; a single dot stays.
    const dotCount = (s.match(/\./g) || []).length;
    if (dotCount > 1) s = s.replace(/\./g, '');
  }

  const n = Number(s);
  return isFinite(n) ? n : null;
}
