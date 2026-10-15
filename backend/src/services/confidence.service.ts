/**
 * services/confidence.service.ts — Refinement gating + required-field map.
 *
 * NOTE: an earlier grid-fit scoring experiment (computeConfidence and its
 * signal/weight tables) was removed — it never shipped (filled-ratio won)
 * and had zero callers. Only the gating logic below is live.
 */

export const REQUIRED_FIELDS: Record<string, string[]> = {
  invoice: ["totalAmount", "invoiceDate"],
  receipt: ["totalAmount", "invoiceDate"],
  bill: ["totalAmount", "invoiceDate"],
  payment: ["totalAmount", "invoiceDate"],
  payslip: ["totalAmount"],
  settlement_slip: ["totalAmount"],
  other: ["totalAmount"],
  unknown: ["totalAmount"],
};

/**
 * Checks YYYY-MM-DD plausibility (format + calendar + sane range).
 * @param s Candidate value
 * @returns Valid flag
 */
export function isValidDate(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 2000 || y > 2030 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Decides whether a finished local result deserves background cloud
 * refinement. No magic threshold: enqueue when required fields are
 * missing/invalid, or when stages disagreed (recorded in attempts).
 * Vendor-only gaps stay local (cosmetic; cloud rarely fixes them and
 * quota is scarce).
 * @param data Extracted fields
 * @param documentType Decided type
 * @param attempts Cascade attempts (for disagreement signals)
 * @returns Needed flag with human-readable reason
 */
export function needsRefinement(
  data: Record<string, unknown>,
  documentType: string,
  attempts: Array<{ fallbackReason?: string }>,
): { needed: boolean; reason?: string } {
  const req = REQUIRED_FIELDS[documentType] ?? REQUIRED_FIELDS.unknown;
  const missing = req.filter((k) => {
    if (k === "totalAmount")
      return !(
        typeof data.totalAmount === "number" &&
        isFinite(data.totalAmount) &&
        (data.totalAmount as number) >= 0
      );
    if (k === "invoiceDate") return !isValidDate(data.invoiceDate);
    return data[k] == null;
  });
  if (missing.length > 0)
    return {
      needed: true,
      reason: `missing required fields: ${missing.join(",")}`,
    };
  const disagree = (attempts ?? []).some((a) =>
    (a.fallbackReason ?? "").includes("disagree"),
  );
  if (disagree)
    return { needed: true, reason: "strategies disagreed on field values" };
  return { needed: false };
}
