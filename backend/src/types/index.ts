/**
 * types/index.ts — Shared document and extraction types.
 */

export type DocumentStatus = "pending" | "processing" | "done" | "failed";

export type DocumentType =
  | "invoice"
  | "receipt"
  | "payment"
  | "bill"
  | "payslip"
  | "settlement_slip"
  | "other"
  | "unknown";

export type DocumentCategory = "financial" | "unknown";

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
}

export type ExtractionOrder = "model-first" | "rules-first";
