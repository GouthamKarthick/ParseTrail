/**
 * utils/conversion.ts — Free currency conversion (no API key).
 * Primary: Frankfurter.app (ECB rates). Fallback: open.er-api.com.
 * Caches rates for a configurable TTL to avoid hammering the APIs.
 */

import { config } from "../config.js";
import { logger } from "../config/logger.js";

interface RateCacheEntry {
  rate: number;
  timestamp: number;
}

const rateCache = new Map<string, RateCacheEntry>();

/** In-flight rate fetches keyed by pair — concurrent callers share one HTTP round-trip. */
const inflight = new Map<string, Promise<number>>();

async function fetchFrankfurterRate(from: string, to: string): Promise<number> {
  const base = config.currencyConversion.url.replace(/\/$/, "");
  const url = `${base}/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.currencyConversion.timeoutMs) });
  if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
  const payload = (await res.json()) as { rates?: Record<string, number> };
  const rate = payload.rates?.[to];
  if (typeof rate !== "number" || !isFinite(rate)) throw new Error("Invalid Frankfurter rate");
  return rate;
}

async function fetchErApiRate(from: string, to: string): Promise<number> {
  const base = config.currencyConversion.fallbackUrl.replace(/\/$/, "");
  const url = `${base}/${encodeURIComponent(from)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.currencyConversion.timeoutMs) });
  if (!res.ok) throw new Error(`ER-API HTTP ${res.status}`);
  const payload = (await res.json()) as { rates?: Record<string, number> };
  const rate = payload.rates?.[to];
  if (typeof rate !== "number" || !isFinite(rate)) throw new Error("Invalid ER-API rate");
  return rate;
}

export interface ConversionOutcome {
  converted: number;
  rate: number;
}

/**
 * Convert with rate metadata (for auditability).
 * @param amount Amount in source currency
 * @param from Source code (e.g. "EUR")
 * @param to Target code (e.g. "INR")
 * @returns Converted amount + rate, or null on failure
 */
export async function convertWithMeta(
  amount: number,
  from: string,
  to: string,
): Promise<ConversionOutcome | null> {
  if (typeof amount !== "number" || !isFinite(amount)) return null;
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (amount === 0) return { converted: 0, rate: 1 };
  const fromNorm = from.trim().toUpperCase();
  const toNorm = to.trim().toUpperCase();
  if (!fromNorm || !toNorm) return null;
  if (fromNorm === toNorm) return { converted: amount, rate: 1 };
  const cacheKey = `${fromNorm}_${toNorm}`;
  const now = Date.now();
  const cached = rateCache.get(cacheKey);
  if (cached && now - cached.timestamp < config.currencyConversion.cacheTtlMs) {
    return { converted: amount * cached.rate, rate: cached.rate };
  }
  const pending = inflight.get(cacheKey);
  if (pending) {
    try {
      const rate = await pending;
      return { converted: amount * rate, rate };
    } catch {
      return null;
    }
  }
  const task = (async (): Promise<number> => {
    try {
      return await fetchFrankfurterRate(fromNorm, toNorm);
    } catch (e) {
      logger.warn("Frankfurter failed, trying ER-API fallback", { error: (e as Error).message });
      return fetchErApiRate(fromNorm, toNorm);
    }
  })();
  inflight.set(cacheKey, task);
  try {
    const rate = await task;
    rateCache.set(cacheKey, { rate, timestamp: Date.now() });
    return { converted: amount * rate, rate };
  } catch (err) {
    logger.warn("Currency conversion failed", {
      from: fromNorm,
      to: toNorm,
      amount,
      error: (err as Error).message,
    });
    return null;
  } finally {
    if (inflight.get(cacheKey) === task) inflight.delete(cacheKey);
  }
}

export interface ConvertibleData {
  totalAmount?: unknown;
  currency?: unknown;
  totalAmountConverted?: number | null;
  currencyConverted?: string | null;
  conversionRate?: number | null;
  conversionAt?: string | null;
}

/**
 * Clears stale derived FX fields and recomputes them in place (best-effort).
 * Single shared implementation for extraction, corrections, and reprocessing.
 * @param data Extracted data record (mutated)
 * @param target Target display currency (defaults to configured target)
 * @returns void
 */
export async function applyConversion(
  data: ConvertibleData,
  target: string = config.currencyConversion.targetCurrency,
): Promise<void> {
  if (typeof data.totalAmount !== "number" || typeof data.currency !== "string" || !data.currency) {
    return;
  }
  const to = target.trim().toUpperCase();
  const from = data.currency.trim().toUpperCase();
  if (from === to) {
    data.totalAmountConverted = data.totalAmount;
    data.currencyConverted = to;
    data.conversionRate = 1;
    data.conversionAt = new Date().toISOString();
    return;
  }
  const r = await convertWithMeta(data.totalAmount, from, to);
  if (r !== null) {
    data.totalAmountConverted = Math.round(r.converted * 100) / 100;
    data.currencyConverted = to;
    data.conversionRate = r.rate;
    data.conversionAt = new Date().toISOString();
  }
}

/**
 * Removes derived FX fields without recomputing.
 * @param data Extracted data record (mutated)
 * @returns void
 */
export function clearConversion(data: ConvertibleData): void {
  delete data.totalAmountConverted;
  delete data.currencyConverted;
  delete data.conversionRate;
  delete data.conversionAt;
}
