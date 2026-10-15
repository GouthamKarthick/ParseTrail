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

export function validateFrontendField(
  name: string,
  value: string,
  maxLen = 255,
): string | null {
  if (isSuspiciousFrontend(value))
    return `Suspicious input in ${name} — not saved`;
  if (value.length > maxLen) return `${name} too long`;
  return null;
}
