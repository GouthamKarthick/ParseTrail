/**
 * utils/json.ts — Shared JSON helpers (stripJsonFence was duplicated in
 * ai.service.ts and transformers.service.ts; DB JSON parsing in 6 places).
 */

/**
 * Strips markdown code fences from a model response.
 * @param s Raw string
 * @returns Clean string
 */
export function stripJsonFence(s: string): string {
  const t = s.trim();
  if (t.startsWith("```"))
    return t
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  return t;
}

/**
 * Parses a DB JSON column that may already be an object.
 * @param value Column value
 * @param fallback Fallback when unparseable
 * @returns Parsed value or fallback
 */
export function parseJsonColumn<T>(
  value: string | T | null | undefined,
  fallback: T,
): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
