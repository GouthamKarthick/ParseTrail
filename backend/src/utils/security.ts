/**
 * security.ts — Input validation and sanitization helpers.
 */

const SQL_PATTERNS = [
  /(\bUNION\b.*\bSELECT\b)/i,
  /(\bSELECT\b.*\bFROM\b)/i,
  /(\bINSERT\b.*\bINTO\b)/i,
  /(\bDELETE\b.*\bFROM\b)/i,
  /(\bDROP\b.*\bTABLE\b)/i,
  /(\bUPDATE\b.*\bSET\b)/i,
  /(--\s)/,
  /(;\s*--)/,
  /(\bOR\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+)/i,
  /(\bEXEC\b|\bEXECUTE\b)/i,
  /(\bINFORMATION_SCHEMA\b)/i,
];

const XSS_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /onerror\s*=/i,
  /onload\s*=/i,
  /<iframe/i,
  /<img[^>]*onerror/i,
];

const PATH_PATTERNS = [/\.\.\//, /\.\.\\/, /%2e%2e/i];

/**
 * Checks if input matches suspicious SQL/XSS/path patterns.
 * @param input Input string
 * @returns True if suspicious
 */
export function isSuspicious(input: string | undefined | null): boolean {
  if (!input || typeof input !== "string") return false;
  const s = input.toString();
  if (s.length > 1000) return true;
  for (const p of [...SQL_PATTERNS, ...XSS_PATTERNS, ...PATH_PATTERNS]) {
    if (p.test(s)) return true;
  }
  if ((s.match(/;/g) || []).length > 1 && /SELECT|INSERT|DELETE/i.test(s))
    return true;
  return false;
}
