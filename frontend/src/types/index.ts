/**
 * @fileoverview Shared domain type definitions for ClarityDocs frontend.
 * Defines document statuses, types, categories, and extraction data shapes.
 */

// ---------------------------------------------------------------------------
// Constants & Type Aliases
// ---------------------------------------------------------------------------

/** Document processing lifecycle status. */
export type DocumentStatus = "pending" | "processing" | "done" | "failed";

/** Recognised document type discriminator. */
export type DocumentType =
  | "invoice"
  | "receipt"
  | "payment"
  | "bill"
  | "payslip"
  | "settlement_slip"
  | "other"
  | "unknown";

/** High-level document category. */
export type DocumentCategory = "financial" | "unknown";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Structured financial fields extracted from a document. */
export interface FinancialData {
  vendor?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  totalAmount?: number;
  currency?: string;
}

/** Flexible extracted payload — financial fields plus any extra keys. */
export type ExtractedData = FinancialData & Record<string, unknown>;

/** One recorded rung of the extraction cascade. */
export interface ExtractionAttempt {
  method: string;
  predicted_type?: string | null;
  confidence: number;
  latency_ms: number;
  cost_estimate: number;
  succeeded: number | boolean;
  fallback_reason?: string | null;
  created_at: string;
}

/** One user correction record. */
export interface Correction {
  field: string;
  original_value?: string | null;
  corrected_value?: string | null;
  extraction_method?: string | null;
  confidence?: number | null;
  created_at: string;
}

/** Full document record as returned by the backend. */
export interface Document {
  id: string;
  name: string;
  path: string;
  status: DocumentStatus;
  document_type: DocumentType;
  document_category: DocumentCategory;
  data: ExtractedData | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  refine_status?: string | null;
}
