/**
 * utils/currency.ts — Converts currency names/symbols to standard codes.
 * Replaces 5 scattered symbol/code mappers across the codebase.
 */

const CURRENCY_CODES: Record<string, string> = {
  INR: 'INR',
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
  AUD: 'AUD',
  SGD: 'SGD',
  AED: 'AED',
  CAD: 'CAD',
};

/**
 * Converts a currency code or symbol to standard ISO-4217 code.
 * @param rawValue Raw currency value like "USD", "$", "₹", "Rs."
 * @returns Standard 3-letter currency code or null if unknown
 */
export function standardizeCurrency(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') return null;
  const cleaned = rawValue.trim().toUpperCase();
  if (!cleaned) return null;
  if (CURRENCY_CODES[cleaned]) return cleaned;
  if (cleaned.includes('₹') || cleaned.includes('RS')) return 'INR';
  if (cleaned.includes('A$')) return 'AUD';
  if (cleaned.includes('S$')) return 'SGD';
  if (cleaned.includes('AED')) return 'AED';
  if (cleaned.includes('CAD')) return 'CAD';
  if (cleaned.includes('$')) return 'USD';
  if (cleaned.includes('€')) return 'EUR';
  if (cleaned.includes('£')) return 'GBP';
  return null;
}

/**
 * Finds currency code from document text by looking for symbols/codes.
 * @param documentText Document text content
 * @returns Standard 3-letter currency code or null if not found
 */
export function findCurrencyInText(documentText: string): string | null {
  if (documentText.includes('₹') || /Rs\.?/.test(documentText)) return 'INR';
  if (/\bAUD\b|\bA\$/.test(documentText)) return 'AUD';
  if (/\bSGD\b|\bS\$/.test(documentText)) return 'SGD';
  if (/\bAED\b/.test(documentText)) return 'AED';
  if (/\bCAD\b/.test(documentText)) return 'CAD';
  if (documentText.includes('$')) return 'USD';
  if (documentText.includes('€')) return 'EUR';
  if (documentText.includes('£')) return 'GBP';
  return null;
}
