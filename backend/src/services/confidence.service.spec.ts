import { describe, it, expect } from "vitest";
import { needsRefinement } from "./confidence.service.js";

describe("confidence — needsRefinement", () => {
  it("needs refinement when required total is missing", () => {
    const r = needsRefinement(
      { vendor: "V", invoiceDate: "2026-01-01" },
      "invoice",
      [],
    );
    expect(r.needed).toBe(true);
    expect(r.reason).toMatch(/totalAmount/);
  });
  it("needs refinement when date is invalid", () => {
    const r = needsRefinement(
      { vendor: "V", totalAmount: 10, invoiceDate: "not-a-date" },
      "invoice",
      [],
    );
    expect(r.needed).toBe(true);
    expect(r.reason).toMatch(/invoiceDate/);
  });
  it("needs refinement on strategy disagreement even when complete", () => {
    const r = needsRefinement(
      { vendor: "V", totalAmount: 10, invoiceDate: "2026-01-01" },
      "invoice",
      [
        {
          fallbackReason:
            "rules/model disagree on invoiceDate, escalating to cloud",
        },
      ],
    );
    expect(r.needed).toBe(true);
    expect(r.reason).toMatch(/disagreed/);
  });
  it("does not need refinement when complete and agreed", () => {
    const r = needsRefinement(
      { vendor: "V", totalAmount: 10, invoiceDate: "2026-01-01" },
      "invoice",
      [{ fallbackReason: undefined }],
    );
    expect(r.needed).toBe(false);
  });
  it("does not need refinement for vendor-only gaps", () => {
    const r = needsRefinement(
      { totalAmount: 10, invoiceDate: "2026-01-01" },
      "receipt",
      [],
    );
    expect(r.needed).toBe(false);
  });
  it("payslip needs only the total", () => {
    expect(needsRefinement({ totalAmount: 5000 }, "payslip", []).needed).toBe(
      false,
    );
    expect(needsRefinement({ vendor: "V" }, "payslip", []).needed).toBe(true);
  });
});
