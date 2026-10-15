/**
 * services/transformers.service.ts — Local Flan-T5 extraction.
 *
 * All regex-based extraction rules live in utils/regex-utils.ts; this module
 * owns only the model loader and the deterministic composition around it.
 */

import { logger } from "../config/logger.js";
import { stripJsonFence } from "../utils/json.js";
import { normalizeCurrency } from "../utils/currency.js";
import { normalizeDateISO } from "../utils/date.js";
import { parseAmount } from "../utils/amount.js";
import {
  cleanInvoiceNumber,
  cleanVendorCandidate,
  extractAmountFallback,
  extractCurrencyFallback,
  extractDateFallback,
  extractInvoiceNumberFallback,
  firstVendorLine,
} from "../utils/regex-utils.js";
import { getStrategy } from "./strategies.js";

export {
  cleanInvoiceNumber,
  cleanVendorCandidate,
  extractAmountFallback,
  extractCurrencyFallback,
  extractDateFallback,
  extractInvoiceNumberFallback,
  firstVendorLine,
};

type Text2TextPipeline = (prompt: string, opts?: { max_new_tokens?: number; temperature?: number }) => Promise<Array<{ generated_text: string }>>;

let llmPipeline: Text2TextPipeline | null = null;
let llmLoadPromise: Promise<Text2TextPipeline | null> | null = null;

/**
 * Loads and caches the quantized local Flan-T5 pipeline.
 * @returns Pipeline or null when the model is unavailable
 */
async function getLocalLLM(): Promise<Text2TextPipeline | null> {
  if (llmPipeline) return llmPipeline;
  if (llmLoadPromise) return llmLoadPromise;
  llmLoadPromise = (async () => {
    try {
      const mod: unknown = await import("@huggingface/transformers");
      const fn = (mod as { default?: unknown }).default ?? mod;
      if (typeof fn !== "function") throw new Error("pipeline not found");
      const p = await fn("text2text-generation", "Xenova/flan-t5-small", { quantized: true });
      llmPipeline = p as Text2TextPipeline;
      logger.info("Flan-T5 local LLM loaded (quantized, pre-baked)");
      return llmPipeline;
    } catch (e) {
      logger.warn("Failed to load local LLM, will fallback to Gemini", { error: (e as Error).message });
      return null;
    } finally {
      llmLoadPromise = null;
    }
  })();
  return llmLoadPromise;
}

/**
 * Deterministic-only extraction: all rule helpers, zero model calls.
 * The "rule-based" strategy rung — cheap floor for the cascade and the
 * rules-first ordering candidate measured in eval/compare.ts.
 * @param text Document text
 * @param documentType Type hint
 * @returns Extracted data, confidence, type
 */
export function extractRulesOnly(text: string, documentType: string): { data: Record<string, unknown>; confidence: number; documentType: string } {
  const data: Record<string, unknown> = {};
  const vendor = firstVendorLine(text);
  if (vendor) data.vendor = vendor;
  const invNum = extractInvoiceNumberFallback(text);
  if (invNum) data.invoiceNumber = invNum;
  const date = extractDateFallback(text);
  if (date) data.invoiceDate = date;
  const amt = extractAmountFallback(text);
  if (amt != null) data.totalAmount = amt;
  const cur = extractCurrencyFallback(text);
  if (cur) data.currency = cur;
  const filled = Object.keys(data).length;
  return { data, confidence: Math.min(1, filled / 5) * 0.85, documentType };
}

/**
 * Runs local LLM extraction with regex fallbacks.
 * @param text Document text
 * @param documentType Type hint
 * @returns Extracted data, confidence, type
 */
export async function runLocalLLMExtraction(text: string, documentType: string): Promise<{ data: Record<string, unknown>; confidence: number; documentType: string }> {
  const ex = getStrategy(documentType).localExample;
  const prompt = `Task: extract ${documentType} as JSON only.\n` + `Example:\nText: "${ex.text}"\nJSON: ${ex.json}\n\n` + `Text: "${text.slice(0, 800).replace(/\n/g, " ")}"\nJSON:`;
  try {
    const pipe = await getLocalLLM();
    if (!pipe) return { data: {}, confidence: 0, documentType };
    const out = await pipe(prompt, { max_new_tokens: 256, temperature: 0.0 } as unknown as Record<string, unknown>);
    const raw = out[0]?.generated_text?.trim() ?? "";
    let jsonStr = stripJsonFence(raw);
    const lastJsonIdx = jsonStr.lastIndexOf("JSON:");
    if (lastJsonIdx >= 0) jsonStr = jsonStr.slice(lastJsonIdx + 5).trim();
    const start = jsonStr.indexOf("{");
    const end = jsonStr.lastIndexOf("}");
    const slice = start >= 0 && end > start ? jsonStr.slice(start, end + 1) : jsonStr;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(slice) as Record<string, unknown>;
    } catch {
      const { data: dataFallback } = extractRulesOnly(text, documentType);
      if (!dataFallback.vendor) {
        const rawVendor = firstVendorLine(raw);
        if (rawVendor) dataFallback.vendor = rawVendor;
      }
      const filledF = Object.keys(dataFallback).length;
      if (filledF > 0) {
        logger.info("Local LLM non-JSON fallback used", { raw: raw.slice(0, 80), dataFallback });
        return { data: dataFallback, confidence: Math.min(1, filledF / 5) * 0.5, documentType };
      }
      throw new Error(`Invalid JSON from Flan: ${raw.slice(0, 80)}`);
    }
    const data: Record<string, unknown> = {};
    const parsedVendor = cleanVendorCandidate(typeof parsed.vendor === "string" ? parsed.vendor : undefined);
    if (parsedVendor) data.vendor = parsedVendor;
    const parsedInvNum = cleanInvoiceNumber(typeof parsed.invoiceNumber === "string" ? parsed.invoiceNumber : undefined);
    if (parsedInvNum) data.invoiceNumber = parsedInvNum;
    if (typeof parsed.invoiceDate === "string" && parsed.invoiceDate.trim()) data.invoiceDate = normalizeDateISO(parsed.invoiceDate);
    const amt = parseAmount(parsed.totalAmount);
    if (amt != null) data.totalAmount = amt;
    const cur = normalizeCurrency(parsed.currency);
    if (cur) data.currency = cur;
    if (!data.vendor || !data.invoiceNumber || !data.invoiceDate || data.totalAmount == null || !data.currency) {
      const rules = extractRulesOnly(text, documentType);
      for (const [k, v] of Object.entries(rules.data)) if (data[k] == null && v != null) data[k] = v;
    }
    const filled = Object.keys(data).length;
    const confidence = Math.min(1, filled / 5) * 0.85;
    logger.info("Local LLM extraction", { documentType, filled, confidence, data });
    return { data, confidence, documentType };
  } catch (e) {
    logger.warn("Local LLM extraction failed", { error: (e as Error).message });
    return { data: {}, confidence: 0, documentType };
  }
}

/**
 * Checks if QA is available.
 * @returns False (deprecated)
 */
export function isQAAvailable(): boolean {
  return false;
}
