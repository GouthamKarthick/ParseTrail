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
export function formatMoney(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).format(value);
    } catch {
      /* unknown code — fall through to plain */
    }
  }
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
