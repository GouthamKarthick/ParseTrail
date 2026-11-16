/**
 * services/strategies.ts — Per-document-type extraction settings.
 *
 * Each document type has cloud prompt instructions plus an example for the
 * local model. Fallback to generic behavior for unknown types.
 */

import type { DocumentType } from '../types/index.js';
import { FINANCIAL_BASE_PROMPT } from '../prompts/financial.js';

export interface DocumentTypeStrategy {
  type: DocumentType | 'other' | 'unknown';
  /** Extra instructions added to the shared cloud prompt. */
  cloudPromptFocus: string;
  /** Example for the local model prompt. */
  localExample: { text: string; json: string };
}

const INVOICE_EXAMPLE = {
  text: 'Acme Corp\nInvoice No: INV-123\nDate: 2024-02-01\nTotal: $1300 USD',
  json: '{"vendor":"Acme Corp","invoiceNumber":"INV-123","invoiceDate":"2024-02-01","totalAmount":1300,"currency":"USD"}',
};

const DOCUMENT_TYPE_STRATEGIES: Record<string, DocumentTypeStrategy> = {
  invoice: {
    type: 'invoice',
    cloudPromptFocus:
      'Focus: invoices — final total due (not subtotal/tax); number is Invoice No/Ref.',
    localExample: INVOICE_EXAMPLE,
  },
  receipt: {
    type: 'receipt',
    cloudPromptFocus:
      'Focus: narrow till receipts — vendor is the shop header; number is Bill No/Receipt No; total is GRAND TOTAL (not subtotal); date is the bill date.',
    localExample: {
      text: 'Chai Point\nBill No: CP-99\nDate: 14/08/2026\nGrand Total Rs 200',
      json: '{"vendor":"Chai Point","invoiceNumber":"CP-99","invoiceDate":"2026-08-14","totalAmount":200,"currency":"INR"}',
    },
  },
  payment: {
    type: 'payment',
    cloudPromptFocus:
      'Focus: transfer/payment confirmations — vendor is the sender or bank; number is the UTR/reference/confirmation code (long digits allowed); total is the amount paid or credited; date is the transaction date. Nulls allowed when absent.',
    localExample: {
      text: 'MIGROS Genossenschafts-Bund\nPayment Advice Ref: 2025009519\nDate: 07.01.2021\nTransferred GBP 18.00',
      json: '{"vendor":"MIGROS Genossenschafts-Bund","invoiceNumber":"2025009519","invoiceDate":"2021-01-07","totalAmount":18,"currency":"GBP"}',
    },
  },
  bill: {
    type: 'bill',
    cloudPromptFocus:
      'Focus: utility bills — vendor is the utility company; total is the amount due/total payable (not past balance or arrears); date is the bill date (not the period start); invoiceNumber is usually null.',
    localExample: {
      text: 'Con Edison\nMeter 12345\nBill date: 03/03/2024\nTotal amount due $90.15',
      json: '{"vendor":"Con Edison","invoiceNumber":null,"invoiceDate":"2024-03-03","totalAmount":90.15,"currency":"USD"}',
    },
  },
  payslip: {
    type: 'payslip',
    cloudPromptFocus:
      'Focus: salary slips — vendor is the employer; total is NET PAY (not gross earnings); invoiceNumber is usually null (EMPCODE is an employee code, not an invoice number); date is the pay date.',
    localExample: {
      text: 'ABC Corp\nPayslip\nPay Date: 06/04/2021\nNet Payment £478.48',
      json: '{"vendor":"ABC Corp","invoiceNumber":null,"invoiceDate":"2021-04-06","totalAmount":478.48,"currency":"GBP"}',
    },
  },
  settlement_slip: {
    type: 'settlement_slip',
    cloudPromptFocus:
      'Focus: settlement/contract statements — vendor is the broker or employer; total is the net payable/settlement amount; number is the settlement/contract number when printed; date may be absent.',
    localExample: {
      text: 'Northstar Analytics Ltd.\nSettlement Statement for August 2026\nNET PAY (₹) : 48,250.00',
      json: '{"vendor":"Northstar Analytics Ltd.","invoiceNumber":null,"invoiceDate":null,"totalAmount":48250,"currency":"INR"}',
    },
  },
};

/**
 * Gets the strategy for a document type, falling back to generic behavior.
 * @param documentType Document type hint
 * @returns Strategy entry for the type
 */
export function getDocumentTypeStrategy(documentType: string): DocumentTypeStrategy {
  const t = (documentType || 'unknown').toLowerCase();
  return (
    DOCUMENT_TYPE_STRATEGIES[t] ?? {
      type: 'unknown',
      cloudPromptFocus: '',
      localExample: INVOICE_EXAMPLE,
    }
  );
}

/**
 * Builds the cloud prompt for a document type.
 * @param documentType Document type hint
 * @returns Cloud prompt text
 */
export function buildCloudPrompt(documentType: string): string {
  const t = (documentType || 'unknown').toLowerCase();
  if (t === 'invoice' || !DOCUMENT_TYPE_STRATEGIES[t]) return FINANCIAL_BASE_PROMPT;
  return `${FINANCIAL_BASE_PROMPT}\n\n${DOCUMENT_TYPE_STRATEGIES[t].cloudPromptFocus}`;
}

/**
 * Per-type cloud prompt instructions, keyed by document type.
 */
export const DOCUMENT_TYPE_FOCUS: Record<DocumentType, string> = {
  invoice: DOCUMENT_TYPE_STRATEGIES.invoice.cloudPromptFocus,
  receipt: DOCUMENT_TYPE_STRATEGIES.receipt.cloudPromptFocus,
  payment: DOCUMENT_TYPE_STRATEGIES.payment.cloudPromptFocus,
  bill: DOCUMENT_TYPE_STRATEGIES.bill.cloudPromptFocus,
  payslip: DOCUMENT_TYPE_STRATEGIES.payslip.cloudPromptFocus,
  settlement_slip: DOCUMENT_TYPE_STRATEGIES.settlement_slip.cloudPromptFocus,
  other:
    'Type focus (other): Not one of the 6 core financial types. Only populate fields if clearly financial; otherwise return nulls and documentType="other".',
  unknown:
    'Classification guide (decide documentType from layout/headings):\n' +
    '- invoice: Formal billing doc ("INVOICE", "TAX INVOICE", "RECHNUNG", GSTIN/VAT, Bill To + line items).\n' +
    '- receipt: Narrow POS/order slip ("RECEIPT", "Bill No", "GRAND TOTAL", tendered/change).\n' +
    '- payment: Confirmation of completed transfer ("Payment Successful", "Transaction ID", "UTR", "Paid").\n' +
    '- bill: Recurring utility/telecom/statement ("Bill Date", "Due Date", "Account No", consumption/meter).\n' +
    '- payslip: Salary statement ("Payslip", "Net Pay", "Gross Earnings", "Deductions", PF/Tax).\n' +
    '- settlement_slip: Merchant/broker payout breakdown ("Settlement", "Payout", "Net Settled", fees).\n' +
    '- other: Non-financial document.',
};

/**
 * Context for building a cloud extraction prompt with optional data.
 */
export interface CloudPromptData {
  /** Heuristic/model-predicted document type, defaults to "unknown". */
  predictedType?: DocumentType;
  /** Fields missing from local extraction that cloud should prioritize. */
  missingFields?: Array<'vendor' | 'invoiceNumber' | 'invoiceDate' | 'totalAmount' | 'currency'>;
  /** Fields where rules and local model disagreed, keyed by field name. */
  conflicts?: Partial<
    Record<
      'invoiceNumber' | 'invoiceDate' | 'totalAmount' | 'currency',
      { rulesValue: string | number | null; localModelValue: string | number | null }
    >
  >;
}

/**
 * Builds the cloud extraction prompt with base instructions plus type focus.
 * @param ctx Optional context with predicted type, missing fields, conflicts
 * @returns Cloud prompt text
 */
export function buildCloudExtractionPrompt(ctx: CloudPromptData = {}): string {
  const typeKey: DocumentType = ctx.predictedType ?? 'unknown';
  const parts: string[] = [
    FINANCIAL_BASE_PROMPT,
    DOCUMENT_TYPE_FOCUS[typeKey] ?? DOCUMENT_TYPE_FOCUS.unknown,
  ];

  if (typeKey !== 'unknown') {
    parts.push(
      `Note: System suggested "${typeKey}", but verify against text and change documentType if text shows another type.`
    );
  }

  if (ctx.conflicts && Object.keys(ctx.conflicts).length > 0) {
    const conflictLines = Object.entries(ctx.conflicts).map(
      ([field, values]) =>
        `- ${field}: rules=${JSON.stringify(values?.rulesValue ?? null)} vs local_model=${JSON.stringify(values?.localModelValue ?? null)}`
    );
    parts.push(
      `Arbitration context (local stages disagreed; verify from source text):\n${conflictLines.join('\n')}`
    );
  } else if (ctx.missingFields && ctx.missingFields.length > 0) {
    parts.push(`Priority missing fields to check: ${ctx.missingFields.join(', ')}.`);
  }

  parts.push('Document text:');
  return parts.join('\n\n');
}

/**
 * Builds the compact local model prompt for core document fields.
 * @param text Raw document text
 * @param oneShotExample Compact "Text: ...\nJSON: ..." example for document type
 * @param maxChars Max characters of text to include (default 1400)
 * @returns Local model prompt text
 */
export function buildLocalModelPrompt(
  text: string,
  oneShotExample: string,
  maxChars = 1400
): string {
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return `Extract vendor, invoiceNumber, invoiceDate (YYYY-MM-DD), totalAmount (number), currency (3-letter code) as JSON. Use null if unknown. Never copy headings or payment labels as vendor.

Example:
${oneShotExample}

Text: ${snippet}
JSON:`;
}
