/**
 * services/confidence.service.ts — Explainable confidence model v1.
 *
 * Score = weighted sum of runtime-observable field signals (no ground truth,
 * no LLM self-report). Weights are grid-fit on fixtures — see
 * eval/confidence-fit.json for provenance. DEFAULT_WEIGHTS mirrors the
 * last fit so the pipeline runs without the fit artifact present.
 */

export interface ConfidenceSignals {
  vendorFound: number;
  dateValid: number;
  totalValid: number;
  typeAgreement: number;
  requiredFields: number;
}

export interface ConfidenceWeights {
  vendorFound: number;
  dateValid: number;
  totalValid: number;
  typeAgreement: number;
  requiredFields: number;
}

export const SIGNAL_KEYS: Array<keyof ConfidenceSignals> = [
  "vendorFound",
  "dateValid",
  "totalValid",
  "typeAgreement",
  "requiredFields",
];

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  vendorFound: 0.2,
  dateValid: 0.2,
  totalValid: 0.25,
  typeAgreement: 0.15,
  requiredFields: 0.2,
};

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
 * Computes observable signals for extracted data.
 * @param data Extracted fields
 * @param finalType Decided document type
 * @param stageTypes Type votes from stages that ran (light, local, cloud)
 * @returns Signal vector (0/1 each, requiredFields fractional)
 */
export function computeSignals(
  data: Record<string, unknown>,
  finalType: string,
  stageTypes: string[],
): ConfidenceSignals {
  const vendorFound =
    typeof data.vendor === "string" && data.vendor.trim().length >= 3 ? 1 : 0;
  const dateValid = isValidDate(data.invoiceDate) ? 1 : 0;
  const totalValid =
    typeof data.totalAmount === "number" &&
    isFinite(data.totalAmount) &&
    (data.totalAmount as number) >= 0
      ? 1
      : 0;
  const req = REQUIRED_FIELDS[finalType] ?? REQUIRED_FIELDS.unknown;
  const met = req.filter((k) =>
    k === "totalAmount"
      ? totalValid === 1
      : k === "invoiceDate"
        ? dateValid === 1
        : data[k] != null,
  ).length;
  const requiredFields = req.length > 0 ? met / req.length : 1;
  const typeAgreement =
    stageTypes.length === 0
      ? 0
      : stageTypes.filter((t) => t === finalType).length / stageTypes.length;
  return { vendorFound, dateValid, totalValid, typeAgreement, requiredFields };
}

/**
 * Scores extracted data with given weights.
 * @param data Extracted fields
 * @param finalType Decided document type
 * @param stageTypes Type votes from stages that ran
 * @param weights Weight vector (default: last fit)
 * @returns Score 0-1 plus signals
 */
export function computeConfidence(
  data: Record<string, unknown>,
  finalType: string,
  stageTypes: string[],
  weights: ConfidenceWeights = DEFAULT_WEIGHTS,
): { score: number; signals: ConfidenceSignals } {
  const signals = computeSignals(data, finalType, stageTypes);
  const score = SIGNAL_KEYS.reduce((a, k) => a + weights[k] * signals[k], 0);
  return { score, signals };
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
