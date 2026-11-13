/**
 * services/summary.service.spec.ts — aggregation with mocked pool (no DB).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/pool.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../db/pool.js";
import { getSummary } from "./summary.service.js";

describe("services/summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps totals and keeps the existing dashboard response shape", async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          kind: "total",
          group_key: null,
          cnt: 2,
          sum_total: "300",
          amount_count: 2,
          avg_confidence: "0.75",
        },
        {
          kind: "type",
          group_key: "invoice",
          cnt: 2,
          sum_total: "300",
        },
        {
          kind: "trend",
          group_key: "2026-10-14",
          cnt: 1,
          sum_total: "100",
        },
        {
          kind: "vendor",
          group_key: "V",
          cnt: 2,
          sum_total: "300",
        },
      ],
    ] as any);

    const summary = await getSummary("u1", 30);
    expect(summary).toEqual({
      totalDocs: 2,
      sumTotal: 300,
      avgUsage: 150,
      avgConfidence: 0.75,
      byType: [{ document_type: "invoice", cnt: 2, sum: 300 }],
      trend: [{ date: "2026-10-14", cnt: 1, sum: 100 }],
      topVendors: [{ vendor: "V", cnt: 2, sum: 300 }],
    });
  });

  it("averages only target-currency documents in a mixed-currency window", async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          kind: "total",
          group_key: null,
          cnt: 3,
          sum_total: "300",
          amount_count: 2,
          avg_confidence: "0.5",
        },
      ],
    ] as any);

    const summary = await getSummary("u1", 30);
    expect(summary.totalDocs).toBe(3);
    expect(summary.sumTotal).toBe(300);
    expect(summary.avgUsage).toBe(summary.sumTotal / 2);
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("COALESCE(currency_converted, currency) = ?"),
      ["u1", 30, "INR"],
    );
    expect(String(vi.mocked(pool.query).mock.calls[0][0])).not.toContain(
      "= 'INR'",
    );
  });

  it("parameterizes the optional category and handles an empty ledger", async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          kind: "total",
          group_key: null,
          cnt: 0,
          sum_total: "0",
          amount_count: 0,
          avg_confidence: "0",
        },
      ],
    ] as any);

    const summary = await getSummary("u1", 30, { category: "financial" });
    expect(summary.avgConfidence).toBe(0);
    expect(summary.avgUsage).toBe(0);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("AND document_category = ?"),
      ["u1", 30, "financial", "INR"],
    );
  });
});
