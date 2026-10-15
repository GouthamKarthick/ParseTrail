import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/pool.js", () => ({
  pool: { query: vi.fn() },
}));

import { pool } from "../db/pool.js";
import { findDuplicateByContent } from "./dedup.service.js";

const mockQuery = vi.mocked(pool.query);

describe("dedup.service — findDuplicateByContent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns not duplicate when any field null (require 4 non-null)", async () => {
    const r = await findDuplicateByContent({
      vendor: "Acme",
      invoiceNumber: "INV1",
    } as any);
    expect(r.duplicate).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("finds duplicate when vendor (case-insensitive), invoiceNo upper, total 2-dec, currency upper match", async () => {
    mockQuery.mockResolvedValue([
      [
        {
          id: "dup-id",
          data: JSON.stringify({
            vendor: "Acme Corp",
            invoiceNumber: "INV-123",
            totalAmount: 1200,
            currency: "INR",
          }),
        },
      ],
    ] as any);
    const r = await findDuplicateByContent({
      vendor: " acme  corp ",
      invoiceNumber: "inv-123",
      totalAmount: 1200.0,
      currency: "inr",
    } as any);
    expect(r.duplicate).toBe(true);
    expect(r.duplicateOf).toBe("dup-id");
  });

  it("total rounding toFixed(2) — 1200 vs 1200.001 still match after rounding", async () => {
    mockQuery.mockResolvedValue([
      [
        {
          id: "a",
          data: JSON.stringify({
            vendor: "V",
            invoiceNumber: "N1",
            totalAmount: 1200,
            currency: "USD",
          }),
        },
      ],
    ] as any);
    const r = await findDuplicateByContent({
      vendor: "V",
      invoiceNumber: "N1",
      totalAmount: 1200.004,
      currency: "USD",
    } as any);
    expect(r.duplicate).toBe(true);
  });

  it("skips invalid JSON rows and returns false when no match", async () => {
    mockQuery.mockResolvedValue([
      [
        { id: "bad", data: "not-json" },
        {
          id: "other",
          data: JSON.stringify({
            vendor: "Other",
            invoiceNumber: "X",
            totalAmount: 999,
            currency: "EUR",
          }),
        },
      ],
    ] as any);
    const r = await findDuplicateByContent({
      vendor: "V",
      invoiceNumber: "N1",
      totalAmount: 10,
      currency: "INR",
    } as any);
    expect(r.duplicate).toBe(false);
  });
});
