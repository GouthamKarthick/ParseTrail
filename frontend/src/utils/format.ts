/**
 * @fileoverview Formatting helpers — locale-aware numbers and money.
 */

/**
 * Format a monetary value with Intl grouping (and currency when known).
 * @param value - Amount or nullish
 * @param currency - ISO code or nullish
 * @returns Formatted string or em dash
 * @example formatMoney(5380.8, "INR") // "₹5,380.80"
 */
const formatterCache = new Map<string, Intl.NumberFormat>();
const plainFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Cached formatter per currency code.
 * @param currency ISO code or nullish
 * @returns Formatter, or plain 2dp formatter for unknown codes
 */
function formatterFor(currency?: string | null): Intl.NumberFormat {
  if (!currency) return plainFormatter;
  const hit = formatterCache.get(currency);
  if (hit) return hit;
  try {
    const f = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    });
    formatterCache.set(currency, f);
    return f;
  } catch {
    /* unknown code — fall through to plain */
  }
  return plainFormatter;
}

export function formatMoney(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatterFor(currency).format(value);
}

/**
 * Format a 0-1 ratio as a percentage string.
 * @param value - Ratio or nullish
 * @returns Percent string or em dash
 * @example formatPercent01(0.85) // "85.0%"
 */
export function formatPercent01(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Strip cosmetic phone formatting (spaces, dashes, parens).
 * @param v - Raw phone input
 * @returns Normalized digits string
 * @example normalizePhone("+91 98-1234 (56)") // "+9198123456"
 */
export function normalizePhone(v: string): string {
  return v.trim().replace(/[\s\-()]/g, "");
}
