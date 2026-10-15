/**
 * services/ai.service.ts — LLM extraction via Gemini/Anthropic.
 */

import { config } from "../config.js";
import { logger } from "../config/logger.js";
import type { ExtractionResult, ExtractedData } from "../types/index.js";
import { DOCUMENT_EXTRACTION_PROMPT } from "../prompts/index.js";
import { getCategory } from "./registry.js";
import { stripJsonFence } from "../utils/json.js";
import { normalizeCurrency } from "../utils/currency.js";
import { normalizeDateISO } from "../utils/date.js";
import { parseAmount } from "../utils/amount.js";
import { cleanVendorCandidate } from "../utils/regex-utils.js";

const ALLOWED_DOCTYPES = new Set([
  "invoice",
  "receipt",
  "payment",
  "bill",
  "payslip",
  "settlement_slip",
  "other",
  "unknown",
]);

/**
 * Normalizes document type to allowed set.
 * @param v Raw type value
 * @returns Normalized type
 */
function normalizeDocumentType(v: unknown): string {
  if (typeof v !== "string") return "unknown";
  const t = v
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_");
  if (ALLOWED_DOCTYPES.has(t)) return t;
  if (t.includes("settlement")) return "settlement_slip";
  if (t.includes("pay") && t.includes("slip")) return "payslip";
  if (t === "inv" || t.includes("invoice")) return "invoice";
  if (t.includes("receipt")) return "receipt";
  if (t.includes("payment")) return "payment";
  if (t === "bill") return "bill";
  return "other";
}

/**
 * Validates and normalizes LLM output.
 * @param raw Raw LLM JSON
 * @returns Normalized data, confidence, type
 */
function validateAndNormalize(raw: unknown): {
  data: ExtractedData;
  confidence: number;
  documentType: string;
} {
  const r = raw as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const docTypeRaw = (r.documentType ?? r.document_type ?? r.type) as unknown;
  const documentType = normalizeDocumentType(docTypeRaw);
  if (typeof r.vendor === "string") {
    const vendor = cleanVendorCandidate(r.vendor);
    if (vendor) data.vendor = vendor.slice(0, 120);
  }
  if (!data.vendor && typeof r.company === "string") {
    const company = cleanVendorCandidate(r.company);
    if (company) data.vendor = company.slice(0, 120);
  }
  if (typeof r.invoiceNumber === "string" && r.invoiceNumber.trim())
    data.invoiceNumber = r.invoiceNumber.trim();
  else if (
    typeof r.invoice_number === "string" &&
    (r.invoice_number as string).trim()
  )
    data.invoiceNumber = (r.invoice_number as string).trim();
  if (typeof r.invoiceDate === "string" && r.invoiceDate.trim())
    data.invoiceDate = normalizeDateISO(r.invoiceDate);
  else if (
    typeof r.invoice_date === "string" &&
    (r.invoice_date as string).trim()
  )
    data.invoiceDate = normalizeDateISO(r.invoice_date as string);
  const amt = parseAmount((r.totalAmount ?? r.total_amount) as unknown);
  if (amt != null) data.totalAmount = amt;
  const cur = normalizeCurrency(r.currency);
  if (cur) data.currency = cur;
  if (Object.keys(data).length === 0) {
    for (const [k, v] of Object.entries(r)) {
      if (["confidence", "documentType", "document_type", "notes"].includes(k))
        continue;
      if (typeof v === "string" && v.trim())
        (data as Record<string, unknown>)[k] = v.trim().slice(0, 500);
      else if (typeof v === "number" && !isNaN(v))
        (data as Record<string, unknown>)[k] = v;
    }
  }
  let confidence = 0;
  if (
    typeof r.confidence === "number" &&
    r.confidence >= 0 &&
    r.confidence <= 1
  )
    confidence = r.confidence;
  else {
    const filled = Object.keys(data).length;
    confidence = Math.min(1, filled / 4);
  }
  return { data: data as ExtractedData, confidence, documentType };
}

/**
 * Calls Gemini API.
 * @param text Extracted text
 * @param imageBase64 Optional image
 * @param mimeType Optional mime
 * @param customPrompt Optional prompt override
 * @returns Parsed JSON
 */
async function callGemini(
  text: string,
  imageBase64?: string,
  mimeType?: string,
  customPrompt?: string,
): Promise<unknown> {
  const key = config.ai.apiKey;
  if (!key) throw new Error("AI_API_KEY not set in backend/.env");
  const model = config.ai.model || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const prompt = customPrompt || DOCUMENT_EXTRACTION_PROMPT;
  const parts: Array<Record<string, unknown>> = [
    { text: prompt },
    { text: text.slice(0, 12000) },
  ];
  if (imageBase64)
    parts.splice(1, 0, {
      inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 },
    });
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  };
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const outText = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!outText) throw new Error("Gemini empty response");
      return JSON.parse(stripJsonFence(outText));
    }
    const errText = await res.text().catch(() => "");
    const isRetryable =
      res.status === 503 || res.status === 429 || res.status === 500;
    logger.warn(`Gemini ${res.status} attempt ${attempt + 1}/4`, {
      err: errText.slice(0, 200),
    });
    if (!isRetryable || attempt === 3)
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
  }
  throw new Error("Gemini retry exhausted");
}

/**
 * Calls Anthropic API.
 * @param text Extracted text
 * @param imageBase64 Optional image
 * @param mimeType Optional mime
 * @param customPrompt Optional prompt override
 * @returns Parsed JSON
 */
async function callAnthropic(
  text: string,
  imageBase64?: string,
  mimeType?: string,
  customPrompt?: string,
): Promise<unknown> {
  const key = config.ai.apiKey;
  if (!key) throw new Error("AI_API_KEY not set");
  const model = config.ai.model.includes("claude")
    ? config.ai.model
    : "claude-3-haiku-20240307";
  const url = "https://api.anthropic.com/v1/messages";
  const prompt = customPrompt || DOCUMENT_EXTRACTION_PROMPT;
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: text.slice(0, 12000) },
  ];
  if (imageBase64)
    content.unshift({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType || "image/jpeg",
        data: imageBase64,
      },
    });
  const body = {
    model,
    max_tokens: 768,
    system: prompt,
    messages: [{ role: "user", content }],
  };
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as { content?: Array<{ text?: string }> };
      const outText = json.content?.[0]?.text;
      if (!outText) throw new Error("Anthropic empty response");
      return JSON.parse(stripJsonFence(outText));
    }
    const errText = await res.text().catch(() => "");
    const isRetryable =
      res.status === 429 || res.status === 500 || res.status === 503;
    logger.warn(`Anthropic ${res.status} attempt ${attempt + 1}/4`, {
      err: errText.slice(0, 200),
    });
    if (!isRetryable || attempt === 3)
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
  }
  throw new Error("Anthropic retry exhausted");
}

/**
 * Extracts fields using configured AI provider.
 * @param text Document text
 * @param opts Optional image/prompt opts
 * @returns Extraction result with latency/cost
 */
export async function extractWithAI(
  text: string,
  opts?: { imageBase64?: string; mimeType?: string; prompt?: string },
): Promise<ExtractionResult & { latency: number; cost: number }> {
  const start = Date.now();
  const provider = config.ai.provider;
  logger.debug("AI request", {
    provider,
    model: config.ai.model,
    textSnippet: text.slice(0, 400),
    promptLen: opts?.prompt?.length,
  });
  const raw =
    provider === "anthropic"
      ? await callAnthropic(
          text,
          opts?.imageBase64,
          opts?.mimeType,
          opts?.prompt,
        )
      : await callGemini(text, opts?.imageBase64, opts?.mimeType, opts?.prompt);
  const { data, confidence, documentType } = validateAndNormalize(raw);
  const latency = Date.now() - start;
  logger.info("AI response", {
    provider,
    method: "llm",
    confidence,
    latency,
    data,
    documentType,
  });
  return {
    data,
    confidence,
    method: "llm",
    latency,
    cost: 0,
    documentType: documentType as ExtractionResult["documentType"],
    documentTypeConfidence: confidence,
    documentCategory: getCategory(documentType),
  };
}

/**
 * Convenience wrapper for AI extraction.
 * @param text Document text
 * @param imageBase64 Optional image base64
 * @param mimeType Optional mime
 * @param customPrompt Optional prompt
 * @returns Extraction result
 */
export async function tryAI(
  text: string,
  imageBase64?: string,
  mimeType?: string,
  customPrompt?: string,
): Promise<ExtractionResult> {
  const r = await extractWithAI(
    text,
    customPrompt
      ? {
          imageBase64,
          mimeType: mimeType || "image/jpeg",
          prompt: customPrompt,
        }
      : { imageBase64, mimeType: mimeType || "image/jpeg" },
  );
  return {
    data: r.data,
    confidence: r.confidence,
    method: r.method,
    documentType: r.documentType as ExtractionResult["documentType"],
    documentTypeConfidence: r.confidence,
    documentCategory: r.documentCategory,
  };
}
