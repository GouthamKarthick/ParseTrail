/**
 * services/extraction.service.ts — Orchestrates PDF parsing, OCR, and LLM extraction.
 */

import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { config } from "../config.js";
import { ruleBasedConfidence } from "../utils/confidence.js";
import { logger } from "../config/logger.js";
import { pool } from "../db/pool.js";
import type {
  AttemptRecord,
  ExtractionOrder,
  ExtractionResult,
  ExtractedData,
} from "../types/index.js";
import { tryAI } from "./ai.service.js";
import { ocrBuffer } from "./ocr.service.js";
import {
  extractRulesOnly,
  runLocalLLMExtraction,
} from "./transformers.service.js";
import { getCategory, getPromptForType } from "./registry.js";
import { applyConversion } from "../utils/conversion.js";

const execFileAsync = promisify(execFile);

/**
 * Augments extracted data with a converted amount (e.g., EUR → INR) using a real‑time API.
 * Called only when both totalAmount and currency are present and conversion is needed.
 * @param data The extracted data (may be mutated)
 * @returns Promise that resolves when enrichment attempt finishes (data may be unchanged on failure)
 */
async function enrichWithConversion(data: ExtractedData): Promise<void> {
  try {
    await applyConversion(data);
  } catch {
    logger.warn("Skipping currency conversion enrichment", {
      totalAmount: data.totalAmount,
      currency: data.currency,
    });
  }
}

/**
 * Detects image mime from buffer header.
 * @param buffer File buffer
 * @returns Mime type
 */
function getImageMime(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50)
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8)
    return "image/jpeg";
  return "image/jpeg";
}

/**
 * Parses PDF text via pdf-parse then pdftotext fallback.
 * @param buffer PDF buffer
 * @returns Extracted text
 */
async function parsePdf(buffer: Buffer): Promise<string> {
  let text = "";
  try {
    const mod: unknown = await import("pdf-parse");
    const fn = (mod as { default?: unknown }).default ?? mod;
    if (typeof fn === "function") {
      const data = await (fn as (b: Buffer) => Promise<{ text: string }>)(
        buffer,
      );
      text = (data.text as string) || "";
      if (text.trim().length > 10) return text;
    }
  } catch (e) {
    logger.warn("pdf-parse failed, trying pdftotext", {
      error: (e as Error).message,
    });
  }
  try {
    const { writeFile, unlink } = await import("fs/promises");
    const tmp = `/tmp/clarity-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
    await writeFile(tmp, buffer);
    try {
      const { stdout } = await execFileAsync("pdftotext", [
        "-layout",
        tmp,
        "-",
      ]);
      text = stdout || "";
    } finally {
      await unlink(tmp).catch(() => {});
    }
    if (text.trim().length > 5) return text;
  } catch (e) {
    logger.warn("pdftotext fallback failed", { error: (e as Error).message });
  }
  return text;
}

/**
 * Lightweight heuristic document type detection.
 * @param text Document text
 * @returns Type and confidence
 */
export function detectDocTypeLight(text: string): {
  type: string;
  confidence: number;
} {
  const t = text.toLowerCase();
  const heading = text.split("\n").slice(0, 10).join("\n").toLowerCase();
  const isNarrowReceipt =
    /grand\s*total/i.test(text) &&
    /rs\.?/i.test(text) &&
    text.split("\n").length < 20;
  const hasMultipage =
    /page\s*1\s*of\s*2/i.test(text) || /page\s*2\s*of\s*2/i.test(text);
  if (heading.includes("settlement slip"))
    return { type: "settlement_slip", confidence: 0.95 };
  if (t.includes("settlement slip"))
    return { type: "settlement_slip", confidence: 0.9 };
  if (
    t.includes("contract note") ||
    t.includes("final settlement") ||
    t.includes("settlement sheet") ||
    t.includes("settlement statement") ||
    /\bsettlement\s*(no|number|date)\b/.test(t)
  )
    return { type: "settlement_slip", confidence: 0.85 };
  if (
    heading.includes("payslip") ||
    t.includes("payslip") ||
    t.includes("pay slip") ||
    t.includes("pay stub") ||
    t.includes("earnings statement") ||
    t.includes("statement of earnings")
  )
    return { type: "payslip", confidence: 0.9 };
  if (
    heading.includes("payment status") ||
    heading.includes("payment received") ||
    t.includes("payment status")
  )
    return { type: "payment", confidence: 0.9 };
  const paySignal =
    /payment\s*advice|transfer\s*confirmation|transaction\s*status|payment\s*successful|successful\s*(payment|transaction)|\bzelle\b|\bupi\b|we have transferred|rent\s*receipt|receipt\s*(for|of)\s*(house\s*)?rent|received.*as rent|rent for the (month|period)/i.test(
      t,
    );
  if (paySignal) return { type: "payment", confidence: 0.9 };
  const hasUtility =
    /kwh|\bmeter\b|energy\s*charge|electricity|electric\s*bill|gas\s*(bill|charge|supply)|water\s*(bill|charge)|power\s*(bill|charge|supply)|supply\s*(address|charges?)|distribution\s*(delivery|charges?)|\butility\b/i.test(
      t,
    );
  const hasDueOrBill =
    /\bamount\s*due|\btotal\s*due|\bbalance\s*due|\bdue\s*date|\bpayment\s*(is\s*)?due|\bpayable\b|bill\s*(date|no|number|period|basis)/i.test(
      t,
    );
  if (hasUtility && hasDueOrBill) return { type: "bill", confidence: 0.8 };
  if (
    isNarrowReceipt ||
    heading.includes("chai point") ||
    /bill\s*no\s*:/i.test(heading)
  )
    return { type: "receipt", confidence: 0.85 };
  if (t.includes("receipt")) return { type: "receipt", confidence: 0.7 };
  if (
    heading.includes("invoice") ||
    heading.includes("rechnung") ||
    /invoice\s*(number|#|no)/i.test(heading)
  )
    return { type: "invoice", confidence: 0.85 };
  if (hasMultipage && /total\s*due/i.test(text))
    return { type: "invoice", confidence: 0.8 };
  if (t.includes("invoice") || t.includes("rechn"))
    return { type: "invoice", confidence: 0.6 };
  if (/^\s*bill\s*$/im.test(heading)) return { type: "bill", confidence: 0.6 };
  if (
    /amount\s*:\s*[0-9]/i.test(text) &&
    !/invoice|receipt|payment|payslip|settlement/i.test(t)
  )
    return { type: "other", confidence: 0.5 };
  if (text.trim().length < 15) return { type: "unknown", confidence: 0.3 };
  return { type: "other", confidence: 0.4 };
}

/**
 * Compares deterministic vs model values on conflict-prone fields.
 * Vendor is excluded (formatting variance); numbers/dates/currency/numbers
 * that differ indicate a genuine extraction conflict worth escalating.
 * @param rules Deterministic output
 * @param model Model output
 * @returns Conflicting field names
 */
function fieldsConflict(
  rules: Record<string, unknown>,
  model: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const norm = (v: unknown): string | null =>
    typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : null;
  for (const k of ["invoiceNumber", "invoiceDate", "totalAmount", "currency"]) {
    const x = norm(rules[k]);
    const y = norm(model[k]);
    if (x != null && y != null && x !== y) out.push(k);
  }
  return out;
}

/**
 * Persists cascade attempts for a document (best-effort, never throws).
 * @param documentId Document id
 * @param attempts Attempt records
 * @returns void
 */
export async function recordAttempts(
  documentId: string,
  attempts: AttemptRecord[] | undefined,
): Promise<void> {
  try {
    if (!documentId || !attempts || attempts.length === 0) return;
    for (const a of attempts) {
      await pool.query(
        "INSERT INTO extraction_attempts (id, document_id, method, predicted_type, confidence, latency_ms, cost_estimate, succeeded, fallback_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          randomUUID(),
          documentId,
          a.method,
          a.predictedType ?? null,
          a.confidence,
          a.latencyMs,
          a.cost,
          a.succeeded ? 1 : 0,
          a.fallbackReason ?? null,
        ],
      );
    }
  } catch (e) {
    logger.warn("Failed to record extraction attempts", {
      error: (e as Error).message,
    });
  }
}

interface RulesStageOut {
  data: Record<string, unknown> | null;
  conf: number;
  passed: boolean;
}

interface LocalStageOut {
  data: Record<string, unknown> | null;
  conf: number;
  type: string;
  typeConf: number;
  fresh: boolean;
  passed: boolean;
}

type FinalResult = ExtractionResult & {
  attempts: AttemptRecord[];
  typeVotes: string[];
};

/**
 * Runs the deterministic rules stage (rules-first order only).
 * Pass/fail decision stays with the caller; vendor seed is dropped on
 * escalation so noisy free text never poisons the model stages.
 * @param text Document text
 * @param hasText Whether usable text exists
 * @param rulesFirst Active ordering
 * @param lightType Heuristic type vote
 * @param attempts Mutable attempt ledger
 * @returns Stage output or null when not applicable
 */
function runRulesStage(
  text: string,
  hasText: boolean,
  rulesFirst: boolean,
  lightType: { type: string; confidence: number },
  attempts: AttemptRecord[],
): RulesStageOut | null {
  if (!rulesFirst || !hasText || text.trim().length <= 30) return null;
  const t0 = Date.now();
  const rules = extractRulesOnly(text, lightType.type);
  const ruleFields = Object.keys(rules.data).length;
  const rulesOk = ruleFields > 0 && rules.confidence >= 0.4;
  attempts.push({
    method: "rule-based",
    predictedType: lightType.type,
    confidence: rules.confidence,
    latencyMs: Date.now() - t0,
    cost: 0,
    succeeded: rulesOk,
    fallbackReason: rulesOk
      ? undefined
      : `rule confidence ${rules.confidence} < 0.4, escalating to local model`,
  });
  const data = ruleFields > 0 ? { ...rules.data } : null;
  const passed = rulesOk && lightType.confidence >= 0.4;
  if (!passed && data) delete data.vendor;
  if (!passed)
    logger.info("Rules-first escalating to local model", {
      ruleFields,
      ruleConf: rules.confidence,
    });
  return { data, conf: rules.confidence, passed };
}

/**
 * Runs the local Flan stage, merging into the rules seed when present.
 * Model-vs-rules conflicts keep deterministic values and force escalation.
 * @param text Document text
 * @param hasText Whether usable text exists
 * @param rulesFirst Active ordering
 * @param lightType Heuristic type vote
 * @param seed Rules seed or null
 * @param attempts Mutable attempt ledger
 * @param typeVotes Mutable type-vote ledger
 * @returns Stage output (fresh=false when Flan yielded nothing)
 */
async function runLocalStage(
  text: string,
  hasText: boolean,
  rulesFirst: boolean,
  lightType: { type: string; confidence: number },
  seed: { data: Record<string, unknown>; conf: number } | null,
  attempts: AttemptRecord[],
  typeVotes: string[],
): Promise<LocalStageOut | null> {
  if (!(hasText && text.trim().length > 30)) {
    return seed
      ? {
          data: seed.data,
          conf: seed.conf,
          type: lightType.type,
          typeConf: lightType.confidence,
          fresh: false,
          passed: false,
        }
      : null;
  }
  const t0 = Date.now();
  let conflictNote: string | undefined;
  try {
    const localRes = await runLocalLLMExtraction(text, lightType.type);
    const flanLatency = Date.now() - t0;
    if (localRes && Object.keys(localRes.data).length > 0) {
      let data = localRes.data;
      let conf = localRes.confidence;
      let type = localRes.documentType;
      let typeConf = localRes.confidence;
      if (rulesFirst && seed?.data) {
        let filledByFlan = 0;
        const norm = (v: unknown): string | null =>
          typeof v === "number"
            ? String(v)
            : typeof v === "string"
              ? v.trim()
              : null;
        const conflicts: string[] = [];
        for (const [k, v] of Object.entries(localRes.data)) {
          if (seed.data[k] == null && v != null) {
            seed.data[k] = v;
            filledByFlan++;
          } else if (
            k !== "vendor" &&
            seed.data[k] != null &&
            v != null &&
            norm(seed.data[k]) !== norm(v)
          ) {
            conflicts.push(k);
          }
        }
        const filled = Object.keys(seed.data).length;
        data = seed.data;
        ((conf = ruleBasedConfidence(filled)), (type = localRes.documentType));
        typeConf = localRes.confidence;
        logger.info("Local LLM filled rules-first gaps", {
          filledByFlan,
          conflicts,
          confidence: conf,
        });
        if (conflicts.length > 0) {
          conf = Math.min(conf, 0.39);
          conflictNote = `rules/model disagree on ${conflicts.join(",")}, escalating to cloud`;
        }
      } else if (!rulesFirst && hasText && data) {
        const ruleCheck = extractRulesOnly(text, lightType.type);
        const conflicts = fieldsConflict(
          ruleCheck.data,
          localRes.data as Record<string, unknown>,
        );
        for (const k of conflicts) {
          const rv = ruleCheck.data[k];
          if (rv != null) (data as Record<string, unknown>)[k] = rv;
        }
        if (conflicts.length > 0) {
          conflictNote = `rules/model disagree on ${conflicts.join(",")}, escalating to cloud`;
        }
      }
      logger.info("Local LLM extraction", {
        documentType: type,
        confidence: conf,
        data,
      });
      if (!typeVotes.includes(type)) typeVotes.push(type);
      const localOk = conf >= 0.4 && typeConf >= 0.4 && !conflictNote;
      attempts.push({
        method: "local-llm",
        predictedType: type,
        confidence: conf,
        latencyMs: flanLatency,
        cost: 0,
        succeeded: localOk,
        fallbackReason: localOk
          ? undefined
          : (conflictNote ??
            `local confidence ${conf} < 0.4, escalating to cloud`),
      });
      return { data, conf, type, typeConf, fresh: true, passed: localOk };
    }
    attempts.push({
      method: "local-llm",
      predictedType: lightType.type,
      confidence: 0,
      latencyMs: flanLatency,
      cost: 0,
      succeeded: false,
      fallbackReason: "local model returned no fields, escalating to cloud",
    });
    return seed
      ? {
          data: seed.data,
          conf: seed.conf,
          type: lightType.type,
          typeConf: lightType.confidence,
          fresh: false,
          passed: false,
        }
      : {
          data: null,
          conf: 0,
          type: lightType.type,
          typeConf: lightType.confidence,
          fresh: false,
          passed: false,
        };
  } catch (e) {
    attempts.push({
      method: "local-llm",
      predictedType: lightType.type,
      confidence: 0,
      latencyMs: Date.now() - t0,
      cost: 0,
      succeeded: false,
      fallbackReason: `local model error: ${(e as Error).message.slice(0, 120)}`,
    });
    logger.warn("Local LLM failed, will escalate to Gemini", {
      error: (e as Error).message,
    });
    return seed
      ? {
          data: seed.data,
          conf: seed.conf,
          type: lightType.type,
          typeConf: lightType.confidence,
          fresh: false,
          passed: false,
        }
      : {
          data: null,
          conf: 0,
          type: lightType.type,
          typeConf: lightType.confidence,
          fresh: false,
          passed: false,
        };
  }
}

/**
 * Runs the cloud stage (Gemini) with merge/keep/direct semantics.
 * @param args Stage inputs including local output and ledgers
 * @returns Final result, or null when cloud is skipped/inapplicable
 */
async function runCloudStage(args: {
  text: string;
  hasText: boolean;
  isImage: boolean;
  isScannedPdf: boolean;
  buffer: Buffer | null;
  allowCloud: boolean;
  cloudOnly: boolean;
  lightType: { type: string; confidence: number };
  local: LocalStageOut | null;
  attempts: AttemptRecord[];
  typeVotes: string[];
}): Promise<FinalResult | null> {
  const {
    text,
    hasText,
    isImage,
    isScannedPdf,
    buffer,
    allowCloud,
    cloudOnly,
    lightType,
    local,
    attempts,
    typeVotes,
  } = args;
  const localData = local?.data ?? null;
  const localConf = local?.conf ?? 0;
  const localType = local?.type ?? lightType.type;
  const localTypeConf = local?.typeConf ?? lightType.confidence;
  const needAI =
    cloudOnly ||
    !hasText ||
    isImage ||
    isScannedPdf ||
    (localData != null && Object.keys(localData).length === 0) ||
    localConf < 0.4 ||
    localTypeConf < 0.6;
  if (!(
    allowCloud &&
    config.ai.apiKey &&
    (hasText || isImage || isScannedPdf || needAI)
  ))
    return null;
  const t0 = Date.now();
  try {
    const guessedType = localType || lightType.type;
    const prompt = getPromptForType(guessedType);
    const imageBase64 =
      isImage || isScannedPdf ? buffer!.toString("base64") : undefined;
    const imageMime = isScannedPdf ? "application/pdf" : "image/jpeg";
    const aiText = hasText
      ? text
      : `Scanned ${guessedType} with no text layer — extract from image.`;
    const ai: ExtractionResult = await tryAI(
      aiText,
      imageBase64,
      imageMime,
      prompt,
    );
    logger.info("AI extraction", {
      method: ai.method,
      confidence: ai.confidence,
      data: ai.data,
      documentType: ai.documentType,
    });
    const aiLatency = Date.now() - t0;
    if (!typeVotes.includes(ai.documentType)) typeVotes.push(ai.documentType);
    if (
      localData &&
      Object.keys(localData).length > 0 &&
      ai.confidence >= localConf
    ) {
      const merged: Record<string, unknown> = { ...localData };
      let filledFromAI = 0;
      for (const [k, v] of Object.entries(ai.data as Record<string, unknown>))
        if (merged[k] == null && v != null) {
          merged[k] = v;
          filledFromAI++;
        }
      if (filledFromAI > 0) {
        const finalType = ai.documentType || localType;
        attempts.push({
          method: "llm",
          predictedType: ai.documentType,
          confidence: ai.confidence,
          latencyMs: aiLatency,
          cost: 0,
          succeeded: true,
        });
        attempts.push({
          method: "fallback-merge",
          predictedType: finalType,
          confidence: Math.max(localConf, ai.confidence),
          latencyMs: 0,
          cost: 0,
          succeeded: true,
        });
        await enrichWithConversion(merged as ExtractedData);
        return {
          data: merged,
          confidence: Math.max(localConf, ai.confidence),
          method: "local-llm+llm",
          documentType:
            ai.documentType || (localType as ExtractionResult["documentType"]),
          documentTypeConfidence: ai.documentTypeConfidence || localTypeConf,
          documentCategory: getCategory(ai.documentType || localType),
          attempts,
          typeVotes,
        };
      }
    }
    if (
      localData &&
      Object.keys(localData).length > 0 &&
      localConf > ai.confidence &&
      localConf >= 0.4
    ) {
      attempts.push({
        method: "llm",
        predictedType: ai.documentType,
        confidence: ai.confidence,
        latencyMs: aiLatency,
        cost: 0,
        succeeded: false,
        fallbackReason: `cloud confidence ${ai.confidence} < local ${localConf}, keeping local`,
      });
      await enrichWithConversion(localData as ExtractedData);
      return {
        data: localData,
        confidence: localConf,
        method: "local-llm",
        documentType: localType as ExtractionResult["documentType"],
        documentTypeConfidence: localTypeConf,
        documentCategory: getCategory(localType),
        attempts,
        typeVotes,
      };
    }
    attempts.push({
      method: "llm",
      predictedType: ai.documentType,
      confidence: ai.confidence,
      latencyMs: aiLatency,
      cost: 0,
      succeeded: ai.confidence > 0,
      fallbackReason:
        ai.confidence <= 0 ? "cloud returned no confidence" : undefined,
    });
    await enrichWithConversion(ai.data as ExtractedData);
    return {
      data: ai.data,
      confidence: ai.confidence,
      method: ai.method,
      documentType: ai.documentType as ExtractionResult["documentType"],
      documentTypeConfidence: ai.documentTypeConfidence,
      documentCategory: getCategory(ai.documentType as string),
      attempts,
      typeVotes,
    };
  } catch (e) {
    attempts.push({
      method: "llm",
      predictedType: localType,
      confidence: 0,
      latencyMs: Date.now() - t0,
      cost: 0,
      succeeded: false,
      fallbackReason: `cloud error: ${(e as Error).message.slice(0, 120)}`,
    });
    logger.warn("AI extraction failed, falling back to local", {
      error: (e as Error).message,
    });
    if (localData && Object.keys(localData).length > 0) {
      await enrichWithConversion(localData as ExtractedData);
      return {
        data: localData,
        confidence: localConf,
        method: "local-llm",
        documentType: localType as ExtractionResult["documentType"],
        documentTypeConfidence: localTypeConf,
        documentCategory: getCategory(localType),
        attempts,
        typeVotes,
      };
    }
    return null;
  }
}

/**
 * Extracts structured data from file path or buffer.
 * @param filePathOrBuffer File path or buffer
 * @param opts Optional cascade ordering (default rules-first) and cloud flag
 * @returns Extraction result with per-stage attempts and type votes
 */
export async function extract(
  filePathOrBuffer: string | Buffer,
  opts?: {
    order?: ExtractionOrder;
    allowCloud?: boolean;
    cloudOnly?: boolean;
  },
): Promise<
  ExtractionResult & { attempts: AttemptRecord[]; typeVotes: string[] }
> {
  const start = Date.now();
  let text = "";
  let buffer: Buffer | null = null;
  let ocrConfidence = 0;
  let ocrPages = 0;
  try {
    buffer =
      typeof filePathOrBuffer === "string"
        ? await fs.readFile(filePathOrBuffer)
        : filePathOrBuffer;
    const isPdf = buffer.subarray(0, 4).toString() === "%PDF";
    if (isPdf) {
      text = await parsePdf(buffer);
      if (text.trim().length < 20) {
        logger.info("Scanned PDF detected, invoking lib OCR", {
          textLen: text.trim().length,
        });
        try {
          const r = await ocrBuffer(buffer, "application/pdf");
          if (r.text.trim().length > text.trim().length) {
            text = r.text;
            ocrConfidence = r.confidence;
            ocrPages = r.pages;
            logger.info("Lib OCR succeeded for PDF", {
              confidence: ocrConfidence,
              pages: ocrPages,
              textSnippet: text.slice(0, 600),
            });
          }
        } catch (e) {
          logger.warn("Lib OCR failed for PDF, will fallback to AI", {
            error: (e as Error).message,
          });
        }
      }
    } else {
      const mime = getImageMime(buffer);
      logger.info("Image detected, invoking lib OCR", {
        mime,
        size: buffer.length,
      });
      try {
        const r = await ocrBuffer(buffer, mime);
        text = r.text;
        ocrConfidence = r.confidence;
        ocrPages = r.pages;
        logger.info("Lib OCR succeeded for image", {
          mime,
          confidence: ocrConfidence,
          textSnippet: text.slice(0, 600),
        });
      } catch (e) {
        logger.warn("Lib OCR failed for image", {
          error: (e as Error).message,
          mime,
        });
        text = buffer.toString("utf8");
        if (text.trim().length < 5) text = "";
      }
    }
  } catch (e) {
    logger.warn("PDF parse failed", {
      error: (e as Error).message,
      stack: (e as Error).stack,
    });
  }
  const hasText = text.trim().length > 20;
  const isImage = buffer ? buffer.subarray(0, 4).toString() !== "%PDF" : false;
  const isScannedPdf =
    !hasText && buffer ? buffer.subarray(0, 4).toString() === "%PDF" : false;
  const lightType = detectDocTypeLight(text);
  logger.debug("Light type detection", {
    docType: lightType.type,
    docTypeConfidence: lightType.confidence,
    ocrConfidence,
    textSnippet: text.slice(0, 800),
  });
  const attempts: AttemptRecord[] = [
    {
      method: "heuristic-detect",
      predictedType: lightType.type,
      confidence: lightType.confidence,
      latencyMs: 0,
      cost: 0,
      succeeded: lightType.confidence >= 0.5,
      fallbackReason:
        lightType.confidence < 0.5
          ? `low type confidence ${lightType.confidence}, using as hint only`
          : undefined,
    },
  ];
  const typeVotes: string[] = [lightType.type];
  const rulesFirst = (opts?.order ?? "rules-first") === "rules-first";
  const allowCloud = opts?.allowCloud !== false;
  const cloudOnly = opts?.cloudOnly === true;
  const rulesOut = cloudOnly
    ? null
    : runRulesStage(text, hasText, rulesFirst, lightType, attempts);
  if (rulesOut?.passed && rulesOut.data) {
    await enrichWithConversion(rulesOut.data as ExtractedData);
    return {
      data: rulesOut.data,
      confidence: rulesOut.conf,
      method: "rule-based",
      documentType: lightType.type as ExtractionResult["documentType"],
      documentTypeConfidence: lightType.confidence,
      documentCategory: getCategory(lightType.type),
      attempts,
      typeVotes,
    };
  }
  const seed = rulesOut?.data
    ? { data: rulesOut.data, conf: rulesOut.conf }
    : null;
  const local = cloudOnly
    ? null
    : await runLocalStage(
        text,
        hasText,
        rulesFirst,
        lightType,
        seed,
        attempts,
        typeVotes,
      );
  if (
    local &&
    local.passed &&
    local.data &&
    Object.keys(local.data).length > 0
  ) {
    await enrichWithConversion(local.data as ExtractedData);
    return {
      data: local.data,
      confidence: local.conf,
      method: "local-llm",
      documentType: local.type as ExtractionResult["documentType"],
      documentTypeConfidence: local.typeConf,
      documentCategory: getCategory(local.type),
      attempts,
      typeVotes,
    };
  }
  const clouded = await runCloudStage({
    text,
    hasText,
    isImage,
    isScannedPdf,
    buffer,
    allowCloud,
    cloudOnly,
    lightType,
    local,
    attempts,
    typeVotes,
  });
  if (clouded) return clouded;
  if (local && local.data && Object.keys(local.data).length > 0) {
    await enrichWithConversion(local.data as ExtractedData);
    return {
      data: local.data,
      confidence: local.conf,
      method: "local-llm",
      documentType: local.type as ExtractionResult["documentType"],
      documentTypeConfidence: local.typeConf,
      documentCategory: getCategory(local.type),
      attempts,
      typeVotes,
    };
  }
  const latency = Date.now() - start;
  logger.info("Extraction latency (no local/Gemini)", {
    latency,
    method: "local-llm",
    ocrConfidence,
    hasText: text.trim().length,
  });
  return {
    data: {},
    confidence: 0,
    method: "local-llm",
    documentType: lightType.type as ExtractionResult["documentType"],
    documentTypeConfidence: lightType.confidence,
    documentCategory: getCategory(lightType.type),
    attempts,
    typeVotes,
  };
}
