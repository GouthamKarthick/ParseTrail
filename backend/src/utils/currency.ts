/**
 * utils/currency.ts — Single currency normalizer (replaces 5 scattered
 * symbol/code mappers in ai/transformers/dedup/controller).
 */

const CODE_TO_CURRENCY: Record<string, string> = {
  INR: "INR",
  USD: "USD",
  EUR: "EUR",
  GBP: "GBP",
};

/**
 * Normalizes a currency code or symbol to INR/USD/EUR/GBP.
 * @param raw Raw value
 * @returns Currency code or null
 */
export function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase();
  if (!c) return null;
  if (CODE_TO_CURRENCY[c]) return c;
  if (c.includes("₹") || c.includes("RS")) return "INR";
  if (c.includes("$")) return "USD";
  if (c.includes("€")) return "EUR";
  if (c.includes("£")) return "GBP";
  return null;
}

/**
 * Detects currency from free text by symbol presence.
 * @param text Document text
 * @returns Currency code or null
 */
export function detectCurrencyFromText(text: string): string | null {
  if (text.includes("₹") || /Rs\.?/.test(text)) return "INR";
  if (text.includes("$")) return "USD";
  if (text.includes("€")) return "EUR";
  if (text.includes("£")) return "GBP";
  return null;
}
