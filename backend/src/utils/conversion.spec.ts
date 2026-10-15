/**
 * utils/conversion.spec.ts — FX conversion with mocked fetch (no network).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

function ratesPayload(code: string, rate: number) {
  return { ok: true, json: async () => ({ rates: { [code]: rate } }) };
}

describe("utils/conversion", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("convertWithMeta short-circuits same currency without fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { convertWithMeta } = await import("./conversion.js");
    expect(await convertWithMeta(100, "INR", "INR")).toEqual({
      converted: 100,
      rate: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("convertWithMeta returns null for non-finite amount or non-string codes", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { convertWithMeta } = await import("./conversion.js");
    expect(await convertWithMeta(NaN, "EUR", "INR")).toBeNull();
    expect(await convertWithMeta(10, null as any, "INR")).toBeNull();
    expect(await convertWithMeta(10, "EUR", "" as any)).toBeNull();
  });

  it("convertWithMeta uses Frankfurter rate on primary success", async () => {
    const fetchMock = vi.fn(async () => ratesPayload("CHF", 106.5));
    vi.stubGlobal("fetch", fetchMock);
    const { convertWithMeta } = await import("./conversion.js");
    // unique pair per test to avoid module-level cache bleed
    const r = await convertWithMeta(130, "EUR", "CHF");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstUrl = String((fetchMock.mock.calls as unknown[][])[0][0]);
    expect(firstUrl).toContain("frankfurter");
    expect(r!.rate).toBe(106.5);
  });

  it("convertWithMeta falls back to ER-API when Frankfurter fails", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("frankfurter")
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, json: async () => ({ rates: { NZD: 2.5 } }) },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { convertWithMeta } = await import("./conversion.js");
    const r = await convertWithMeta(10, "USD", "NZD");
    expect(r).toEqual({ converted: 25, rate: 2.5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("convertWithMeta returns null when both providers fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    const { convertWithMeta } = await import("./conversion.js");
    expect(await convertWithMeta(10, "EUR", "JPY")).toBeNull();
  });

  it("convertWithMeta serves repeat pairs from cache without refetch", async () => {
    const fetchMock = vi.fn(async () => ratesPayload("SEK", 3));
    vi.stubGlobal("fetch", fetchMock);
    const { convertWithMeta } = await import("./conversion.js");
    expect(await convertWithMeta(10, "GBP", "SEK")).toEqual({
      converted: 30,
      rate: 3,
    });
    expect(await convertWithMeta(20, "GBP", "SEK")).toEqual({
      converted: 60,
      rate: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applyConversion stamps same-currency docs with rate 1", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { applyConversion } = await import("./conversion.js");
    const d: Record<string, unknown> = { totalAmount: 50, currency: "INR" };
    await applyConversion(d, "INR");
    expect(d).toMatchObject({
      totalAmountConverted: 50,
      currencyConverted: "INR",
      conversionRate: 1,
    });
    expect(typeof d.conversionAt).toBe("string");
  });

  it("applyConversion is a no-op without amount/currency", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { applyConversion } = await import("./conversion.js");
    const d: Record<string, unknown> = { vendor: "V" };
    await applyConversion(d, "INR");
    expect(d.totalAmountConverted).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clearConversion removes all derived fields", async () => {
    const { clearConversion } = await import("./conversion.js");
    const d: Record<string, unknown> = {
      totalAmountConverted: 1,
      currencyConverted: "INR",
      conversionRate: 1,
      conversionAt: "x",
    };
    clearConversion(d);
    expect(d).toEqual({});
  });
});
