/**
 * services/registry.ts — Document type categorization and prompts.
 */

import type { DocumentCategory } from "../types/index.js";
import { buildPromptForType } from "./strategies.js";

export const CATEGORY_MAP: Record<string, DocumentCategory> = {
  invoice: "financial",
  receipt: "financial",
  payment: "financial",
  bill: "financial",
  payslip: "financial",
  settlement_slip: "financial",
  other: "unknown",
  unknown: "unknown",
};

/**
 * Maps document type to category.
 * @param documentType Document type string
 * @returns Category
 */
export function getCategory(documentType: string): DocumentCategory {
  const t = (documentType || "unknown").toLowerCase();
  return CATEGORY_MAP[t] ?? "unknown";
}

/**
 * Returns the strategy prompt for a document type (shared schema plus
 * per-type focus lines; invoice returns the historical prompt verbatim).
 * @param documentType Document type
 * @returns Prompt string
 */
export function getPromptForType(documentType: string): string {
  return buildPromptForType(documentType);
}
