/**
 * types/index.ts — Shared document and extraction types.
 */

export type DocumentStatus = 'pending' | 'processing' | 'done' | 'failed';

export type DocumentType =
  'invoice' | 'receipt' | 'payment' | 'bill' | 'payslip' | 'settlement_slip' | 'other' | 'unknown';

export type DocumentCategory = 'financial' | 'unknown';

export interface FinancialData {
  vendor?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  totalAmount?: number;
  currency?: string;
  /** Converted amount in target display currency */
  totalAmountConverted?: number | null;
  /** Target currency code for the converted amount */
  currencyConverted?: string | null;
  /** FX rate used (1 unit source => rate units target) */
  conversionRate?: number | null;
  /** ISO timestamp when the rate was fetched */
  conversionAt?: string | null;
}

export type GenericData = Record<string, unknown>;

export type ExtractedData = FinancialData & GenericData;

export interface ExtractionResult {
  data: ExtractedData;
  confidence: number;
  method: string;
  documentType: DocumentType;
  documentTypeConfidence: number;
  documentCategory: DocumentCategory;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

/**
 * Result of the full extraction cascade: structured data plus the
 * per-stage ledger and any cross-strategy conflicts.
 *
 * The cascade runs in this order:
 *   1. Heuristic type detection (lightweight, zero-cost)
 *   2. Rule-based extraction (deterministic regex, zero-cost)
 *   3. Local LLM (Flan-T5, zero-cost, quantized model)
 *   4. Cloud LLM (Gemini/Groq/OpenRouter, metered cost)
 *
 * Rules win on any conflict with ML outputs. Cloud is only invoked when
 * required fields are missing/invalid or strategies disagreed. Quota is
 * spent only on successful cloud calls. See PRD deviations #10 and #16.
 */
export interface ExtractionCascadeResult extends ExtractionResult {
  /** Per-stage execution ledger, in the order stages ran. */
  attempts: AttemptRecord[];
  /** Fields where deterministic rules and model outputs disagreed. */
  conflicts: string[];
  /** Votes for document type from each stage. */
  typeVotes: string[];
  /** Raw extracted text (truncated to 100k chars). */
  extractedText: string;
}

/**
 * One recorded rung of the extraction cascade: what ran, how long it
 * took, how confident it was, and why the pipeline moved on (or stopped).
 */
export interface AttemptRecord {
  method: string;
  predictedType?: string;
  confidence: number;
  latencyMs: number;
  cost: number;
  succeeded: boolean;
  fallbackReason?: string;
  conflicts?: string[];
  inputTokens?: number;
  outputTokens?: number;
}

export type ExtractionOrder = 'model-first' | 'rules-first';
