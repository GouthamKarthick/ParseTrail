/**
 * @fileoverview Shared badge specs for document status + refinement state.
 */

export type BadgeVariant =
  "neutral" | "info" | "success" | "warning" | "error" | "type";

export interface BadgeSpec {
  variant: BadgeVariant;
  label: string;
}

/**
 * Build a single plain-language status for a document and its refinement job.
 * @param status - Document status
 * @param refineStatus - Latest refine job status or nullish
 * @returns One user-facing status label and its color
 * @example statusBadges("done", "working")
 */
export function statusBadges(
  status: string,
  refineStatus?: string | null,
): BadgeSpec[] {
  if (status === "pending") {
    return [{ variant: "warning", label: "Queued" }];
  }
  if (status === "processing") {
    return [{ variant: "warning", label: "Processing" }];
  }
  if (status === "failed") {
    return [{ variant: "error", label: "Processing failed" }];
  }
  if (status === "done") {
    if (refineStatus === "queued" || refineStatus === "working") {
      return [{ variant: "info", label: "Enhancing with AI" }];
    }
    if (refineStatus === "dead") {
      return [
        { variant: "success", label: "Ready" },
        { variant: "error", label: "AI enhancement unavailable" },
      ];
    }
    return [{ variant: "success", label: "Ready" }];
  }

  return [{ variant: "neutral", label: status }];
}
