import { describe, it, expect } from "vitest";
import { getStrategy, buildPromptForType } from "./strategies.js";
import { FINANCIAL_PROMPT } from "../prompts/financial.js";
import { getPromptForType } from "./registry.js";

describe("strategies — per-type prompts and examples", () => {
  it("invoice returns the historical prompt verbatim", () => {
    expect(buildPromptForType("invoice")).toBe(FINANCIAL_PROMPT);
    expect(getPromptForType("invoice")).toBe(FINANCIAL_PROMPT);
  });
  it("unknown types fall back to generic behavior", () => {
    expect(buildPromptForType("other")).toBe(FINANCIAL_PROMPT);
    expect(buildPromptForType("whatever")).toBe(FINANCIAL_PROMPT);
    expect(getStrategy("whatever").localExample.json).toContain("INV-123");
  });
  it("each financial type carries a focus line and a valid example", () => {
    for (const t of [
      "receipt",
      "payment",
      "bill",
      "payslip",
      "settlement_slip",
    ]) {
      const s = getStrategy(t);
      expect(s.promptFocus.length).toBeGreaterThan(20);
      expect(() => JSON.parse(s.localExample.json)).not.toThrow();
      expect(buildPromptForType(t)).toContain("Focus:");
      expect(buildPromptForType(t)).toContain("Return ONLY JSON");
    }
  });
  it("registry routes prompts through strategies", () => {
    expect(getPromptForType("bill")).toContain("utility");
    expect(getPromptForType("payslip")).toContain("NET PAY");
  });
});
