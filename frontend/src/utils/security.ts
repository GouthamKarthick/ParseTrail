const SQL_RE =
  /(\bUNION\b.*\bSELECT\b|\bSELECT\b.*\bFROM\b|\bINSERT\b.*\bINTO\b|\bDELETE\b.*\bFROM\b|\bDROP\b.*\bTABLE\b|--|;\s*--|\bOR\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+)/i;
const XSS_RE = /<script|javascript:|onerror\s*=|<iframe|<img[^>]*onerror/i;
const PATH_RE = /\.\.\//;

export function isSuspiciousFrontend(input: string): boolean {
  if (!input) return false;
  return (
    SQL_RE.test(input) ||
    XSS_RE.test(input) ||
    PATH_RE.test(input) ||
    input.length > 1000
  );
}

/**
 * Validate password against strength policy.
 * @param pwd - Candidate password
 * @returns Error message or null if valid
 * @example getPasswordError("weak")
 */
export function getPasswordError(pwd: string): string | null {
  if (pwd.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(pwd)) return "Password must contain 1 uppercase letter";
  if (!/\d/.test(pwd)) return "Password must contain 1 number";
  if (!/[^A-Za-z0-9]/.test(pwd))
    return "Password must contain 1 special character";
  return null;
}
