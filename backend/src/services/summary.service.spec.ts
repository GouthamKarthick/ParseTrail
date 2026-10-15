/**
 * services/summary.service.spec.ts — aggregation with mocked pool (no DB).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/pool.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../db/pool.js";
import { getSummary } from "./summary.service.js";

describe("services/summary", () => {
  beforeEach(() => vi.clearAllMocks());

  function mockAll(avgConf: number | string) {
    vi.mocked(pool.query)
      .mockResolvedValueOnce([[{ cnt: 2, sum: "300" }]] as any)
      .mockResolvedValueOnce([
        [{ document_type: "invoice", cnt: 2, sum: "300" }],
      ] as any)
      .mockResolvedValueOnce([[{ date: "2026-10-14", cnt: 1, sum: "100" }]] as any)
      .mockResolvedValueOnce([
        [{ vendor: "V", cnt: 2, sum: "300" }],
      ] as any)
      .mockResolvedValueOnce([[{ avgConf }]] as any);
  }

  it("maps totals and reads avgConfidence from SQL", async () => {
    mockAll(0.75);
    const s = await getSummary("u1", 30);
    expect(s.totalDocs).toBe(2);
    expect(s.sumTotal).toBe(300);
    expect(s.avgUsage).toBe(150);
    expect(s.avgConfidence).toBe(0.75);
    expect(s.byType).toEqual([
      { document_type: "invoice", cnt: 2, sum: 300 },
    ]);
  });

  it("sums prefer converted amounts in the target currency", async () => {
    mockAll(1);
    await getSummary("u1", 30);
    const firstSql = String(vi.mocked(pool.query).mock.calls[0][0]);
    expect(firstSql).toContain("totalAmountConverted");
    expect(firstSql).toContain("currencyConverted");
  });

  it("defaults avgConfidence to 0 when the ledger is empty", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce([[{ cnt: 0, sum: null }]] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any);
    const s = await getSummary("u1", 30);
    expect(s.avgConfidence).toBe(0);
    expect(s.avgUsage).toBe(0);
  });
});
