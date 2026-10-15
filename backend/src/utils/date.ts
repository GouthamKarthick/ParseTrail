/**
 * utils/date.ts — Single ISO date normalizer (replaces normalizeDate in
 * ai.service.ts and normalizeDateLocal in transformers.service.ts).
 */

/**
 * Normalizes common date shapes to YYYY-MM-DD.
 * @param s Raw date string
 * @returns Normalized date, or the trimmed input when unparseable
 */
export function normalizeDateISO(s: string): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return t;
}
