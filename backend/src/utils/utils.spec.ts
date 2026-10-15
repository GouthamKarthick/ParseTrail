import { describe, it, expect } from "vitest";
import { normalizeDateISO } from "./date.js";
import { normalizeCurrency, detectCurrencyFromText } from "./currency.js";
import { parseAmount } from "./amount.js";
import { stripJsonFence, parseJsonColumn } from "./json.js";

describe("utils — shared extractors", () => {
  it("normalizeDateISO handles all known shapes", () => {
    expect(normalizeDateISO("2026-09-03")).toBe("2026-09-03");
    expect(normalizeDateISO("03/09/2026")).toBe("2026-09-03");
    expect(normalizeDateISO("03-09-2026")).toBe("2026-09-03");
    expect(normalizeDateISO("07.01.2021")).toBe("2021-01-07");
    expect(normalizeDateISO("  2026-09-03  ")).toBe("2026-09-03");
    expect(normalizeDateISO("garbage")).toBe("garbage");
  });
  it("normalizeCurrency maps codes and symbols", () => {
    expect(normalizeCurrency("inr")).toBe("INR");
    expect(normalizeCurrency("GBP")).toBe("GBP");
    expect(normalizeCurrency("₹1")).toBe("INR");
    expect(normalizeCurrency("Rs.")).toBe("INR");
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency("€")).toBe("EUR");
    expect(normalizeCurrency("£")).toBe("GBP");
    expect(normalizeCurrency("JPY")).toBeNull();
    expect(normalizeCurrency("")).toBeNull();
    expect(normalizeCurrency(42)).toBeNull();
  });
  it("detectCurrencyFromText scans symbols", () => {
    expect(detectCurrencyFromText("Total ₹500")).toBe("INR");
    expect(detectCurrencyFromText("Total Rs 500")).toBe("INR");
    expect(detectCurrencyFromText("Total $500")).toBe("USD");
    expect(detectCurrencyFromText("Total €500")).toBe("EUR");
    expect(detectCurrencyFromText("Total £500")).toBe("GBP");
    expect(detectCurrencyFromText("Total 500")).toBeNull();
  });
  it("parseAmount scrubs locale noise", () => {
    expect(parseAmount("Rs. 1,200.00")).toBe(1200);
    expect(parseAmount("£1,342.74")).toBe(1342.74);
    expect(parseAmount("€ 99")).toBe(99);
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(Infinity)).toBeNull();
  });
  it("stripJsonFence removes fences", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
  it("parseJsonColumn tolerates objects and garbage", () => {
    expect(parseJsonColumn('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJsonColumn({ a: 1 }, {})).toEqual({ a: 1 });
    expect(parseJsonColumn("nope", { d: 1 })).toEqual({ d: 1 });
    expect(parseJsonColumn(null, { d: 1 })).toEqual({ d: 1 });
  });
});
