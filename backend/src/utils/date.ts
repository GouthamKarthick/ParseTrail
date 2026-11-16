/**
 * utils/date.ts — Single ISO date normalizer (replaces normalizeDate in
 * ai.service.ts and normalizeDateLocal in transformers.service.ts).
 */

/**
 * Normalizes common date shapes to YYYY-MM-DD.
 * @param s Raw date string
 * @param locale Optional 'DD/MM' (default) or 'MM/DD' to disambiguate two-digit day/month order
 * @returns Normalized date, or the trimmed input when unparseable
 */
export function normalizeDateISO(s: string, locale?: 'DD/MM' | 'MM/DD'): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/);
  if (m) {
    const [, a, b, year] = m;
    const day = locale === 'MM/DD' ? b : a;
    const month = locale === 'MM/DD' ? a : b;
    return `${year}-${month}-${day}`;
  }
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return t;
}
