/**
 * services/ai.service.ts — LLM extraction via configured AI providers.
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

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ProviderResult {
  data: unknown;
  tokenUsage?: TokenUsage;
}

async function fetchWithRetry(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
    if (response.ok) return response;
    if (![429, 503].includes(response.status) || attempt === 1) {
      throw new Error(`${provider} request failed with status ${response.status}`);
    }
    logger.warn(`${provider} request throttled; retrying`, {
      status: response.status,
      attempt: attempt + 1,
    });
    await response.body?.cancel();
    const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`${provider} retry exhausted`);
}

async function callGemini(
  text: string,
  imageBase64?: string,
  mimeType?: string,
  customPrompt?: string,
): Promise<ProviderResult> {
  const key = config.ai.apiKey;
  if (!key) throw new Error("Gemini API key is not configured");
  const model = config.ai.model || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const parts: Array<Record<string, unknown>> = [
    { text: customPrompt || DOCUMENT_EXTRACTION_PROMPT },
    { text: text.slice(0, 12000) },
  ];
  if (imageBase64)
    parts.splice(1, 0, {
      inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 },
    });
  const response = await fetchWithRetry("Gemini", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    }),
  });
  const json = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };
  const outText = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!outText) throw new Error("Gemini empty response");
  return {
    data: JSON.parse(stripJsonFence(outText)),
    tokenUsage:
      json.usageMetadata?.promptTokenCount != null &&
      json.usageMetadata.candidatesTokenCount != null
        ? {
            inputTokens: json.usageMetadata.promptTokenCount,
            outputTokens: json.usageMetadata.candidatesTokenCount,
          }
        : undefined,
  };
}

async function callAnthropic(
  text: string,
  imageBase64?: string,
  mimeType?: string,
  customPrompt?: string,
): Promise<ProviderResult> {
  const key = config.ai.apiKey;
  if (!key) throw new Error("Anthropic API key is not configured");
  if (imageBase64 && mimeType === "application/pdf") {
    throw new Error("Anthropic PDF input is unsupported; provide extracted text");
  }
  const model = config.ai.model.includes("claude")
    ? config.ai.model
    : "claude-3-haiku-20240307";
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
  const response = await fetchWithRetry(
    "Anthropic",
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 768,
        system: customPrompt || DOCUMENT_EXTRACTION_PROMPT,
        messages: [{ role: "user", content }],
      }),
    },
  );
  const json = (await response.json()) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const outText = json.content?.[0]?.text;
  if (!outText) throw new Error("Anthropic empty response");
  return {
    data: JSON.parse(stripJsonFence(outText)),
    tokenUsage:
      json.usage?.input_tokens != null && json.usage.output_tokens != null
        ? {
            inputTokens: json.usage.input_tokens,
            outputTokens: json.usage.output_tokens,
          }
        : undefined,
  };
}

async function callCompatibleProvider(
  provider: "groq" | "openrouter",
  text: string,
  customPrompt?: string,
): Promise<ProviderResult> {
  const key =
    provider === "groq" ? config.ai.groqApiKey : config.ai.openRouterApiKey;
  if (!key) throw new Error(`${provider} API key is not configured`);
  const model =
    provider === "groq"
      ? process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
      : process.env.OPENROUTER_MODEL ||
        "meta-llama/llama-3.3-70b-instruct:free";
  const url =
    provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://openrouter.ai/api/v1/chat/completions";
  const response = await fetchWithRetry(provider, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(provider === "openrouter"
        ? { "HTTP-Referer": "https://parsetrail.app", "X-Title": "ParseTrail" }
        : {}),
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: customPrompt || DOCUMENT_EXTRACTION_PROMPT },
        { role: "user", content: text.slice(0, 12000) },
      ],
    }),
  });
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const outText = json.choices?.[0]?.message?.content;
  if (!outText) throw new Error(`${provider} empty response`);
  return {
    data: JSON.parse(stripJsonFence(outText)),
    tokenUsage:
      json.usage?.prompt_tokens != null &&
      json.usage.completion_tokens != null
        ? {
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
          }
        : undefined,
  };
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
): Promise<
  ExtractionResult & {
    latency: number;
    cost: number;
    tokenUsage?: TokenUsage;
  }
> {
  const start = Date.now();
  let provider = "";
  let response: ProviderResult | undefined;
  const errors: string[] = [];
  logger.debug("AI request", {
    providers: config.ai.providers,
    model: config.ai.model,
    textLength: text.length,
    promptLen: opts?.prompt?.length,
  });
  for (const candidate of config.ai.providers) {
    try {
      provider = candidate;
      response =
        candidate === "gemini"
          ? await callGemini(
              text,
              opts?.imageBase64,
              opts?.mimeType,
              opts?.prompt,
            )
          : candidate === "anthropic"
            ? await callAnthropic(
                text,
                opts?.imageBase64,
                opts?.mimeType,
                opts?.prompt,
              )
            : await callCompatibleProvider(candidate, text, opts?.prompt);
      break;
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : `${candidate} request failed`,
      );
      logger.warn("AI provider failed; trying the next configured provider", {
        provider: candidate,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  if (!response)
    throw new Error(
      errors.length
        ? errors.join("; ")
        : "No configured AI provider completed extraction",
    );
  const { data, confidence, documentType } = validateAndNormalize(response.data);
  const latency = Date.now() - start;
  logger.info("AI response", {
    provider,
    method: "llm",
    confidence,
    latency,
    tokenUsage: response.tokenUsage,
    documentType,
  });
  return {
    data,
    confidence,
    method: "llm",
    latency,
    cost: 0,
    tokenUsage: response.tokenUsage,
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
    tokenUsage: r.tokenUsage,
  };
}
