/**
 * services/strategies.ts — Per-type extraction strategies (Phase 4).
 *
 * One entry per financial document type: cloud prompt focus lines plus a
 * 1-shot example for the local Flan prompt. The invoice entry reproduces
 * the historical generic behavior exactly; other types specialize it.
 * Rollout is eval-guarded: a type keeps its strategy only while
 * eval/compare shows neutral-or-better accuracy for it.
 */

import type { DocumentType } from '../types/index.js';
import { FINANCIAL_BASE_PROMPT } from '../prompts/financial.js';

export interface TypeStrategy {
  type: DocumentType | 'other' | 'unknown';
  /** Extra focus lines appended to the shared cloud prompt. */
  promptFocus: string;
  /** 1-shot example shaping the local Flan prompt. */
  localExample: { text: string; json: string };
}

const INVOICE_EXAMPLE = {
  text: 'Acme Corp\nInvoice No: INV-123\nDate: 2024-02-01\nTotal: $1300 USD',
  json: '{"vendor":"Acme Corp","invoiceNumber":"INV-123","invoiceDate":"2024-02-01","totalAmount":1300,"currency":"USD"}',
};

const STRATEGIES: Record<string, TypeStrategy> = {
  invoice: {
    type: 'invoice',
    promptFocus: 'Focus: invoices — final total due (not subtotal/tax); number is Invoice No/Ref.',
    localExample: INVOICE_EXAMPLE,
  },
  receipt: {
    type: 'receipt',
    promptFocus:
      'Focus: narrow till receipts — vendor is the shop header; number is Bill No/Receipt No; total is GRAND TOTAL (not subtotal); date is the bill date.',
    localExample: {
      text: 'Chai Point\nBill No: CP-99\nDate: 14/08/2026\nGrand Total Rs 200',
      json: '{"vendor":"Chai Point","invoiceNumber":"CP-99","invoiceDate":"2026-08-14","totalAmount":200,"currency":"INR"}',
    },
  },
  payment: {
    type: 'payment',
    promptFocus:
      'Focus: transfer/payment confirmations — vendor is the sender or bank; number is the UTR/reference/confirmation code (long digits allowed); total is the amount paid or credited; date is the transaction date. Nulls allowed when absent.',
    localExample: {
      text: 'MIGROS Genossenschafts-Bund\nPayment Advice Ref: 2025009519\nDate: 07.01.2021\nTransferred GBP 18.00',
      json: '{"vendor":"MIGROS Genossenschafts-Bund","invoiceNumber":"2025009519","invoiceDate":"2021-01-07","totalAmount":18,"currency":"GBP"}',
    },
  },
  bill: {
    type: 'bill',
    promptFocus:
      'Focus: utility bills — vendor is the utility company; total is the amount due/total payable (not past balance or arrears); date is the bill date (not the period start); invoiceNumber is usually null.',
    localExample: {
      text: 'Con Edison\nMeter 12345\nBill date: 03/03/2024\nTotal amount due $90.15',
      json: '{"vendor":"Con Edison","invoiceNumber":null,"invoiceDate":"2024-03-03","totalAmount":90.15,"currency":"USD"}',
    },
  },
  payslip: {
    type: 'payslip',
    promptFocus:
      'Focus: salary slips — vendor is the employer; total is NET PAY (not gross earnings); invoiceNumber is usually null (EMPCODE is an employee code, not an invoice number); date is the pay date.',
    localExample: {
      text: 'ABC Corp\nPayslip\nPay Date: 06/04/2021\nNet Payment £478.48',
      json: '{"vendor":"ABC Corp","invoiceNumber":null,"invoiceDate":"2021-04-06","totalAmount":478.48,"currency":"GBP"}',
    },
  },
  settlement_slip: {
    type: 'settlement_slip',
    promptFocus:
      'Focus: settlement/contract/FnF statements — vendor is the broker or employer; total is the net payable/settlement amount; number is the settlement/contract number when printed; date may be absent (null is honest).',
    localExample: {
      text: 'Northstar Analytics Ltd.\nSettlement Statement for August 2026\nNET PAY (₹) : 55,621.00',
      json: '{"vendor":"Northstar Analytics Ltd.","invoiceNumber":null,"invoiceDate":null,"totalAmount":55621,"currency":"INR"}',
    },
  },
};

/**
 * Returns the strategy for a type, falling back to generic invoice behavior.
 * @param documentType Type hint
 * @returns Strategy entry
 */
export function getStrategy(documentType: string): TypeStrategy {
  const t = (documentType || 'unknown').toLowerCase();
  return (
    STRATEGIES[t] ?? {
      type: 'unknown',
      promptFocus: '',
      localExample: INVOICE_EXAMPLE,
    }
  );
}

/**
 * Builds the cloud prompt for a type: shared schema plus focus lines.
 * Invoice returns the historical prompt verbatim (no behavior change).
 * @param documentType Type hint
 * @returns Prompt text
 */
export function buildPromptForType(documentType: string): string {
  const t = (documentType || 'unknown').toLowerCase();
  if (t === 'invoice' || !STRATEGIES[t]) return FINANCIAL_BASE_PROMPT;
  return `${FINANCIAL_BASE_PROMPT}\n\n${STRATEGIES[t].promptFocus}`;
}

/**
 * Per-type cloud prompt focus lines, keyed by DocumentType.
 * Appended to FINANCIAL_BASE_PROMPT when a candidate type is known.
 */
export const CLOUD_TYPE_FOCUS: Record<DocumentType, string> = {
  invoice: STRATEGIES.invoice.promptFocus,
  receipt: STRATEGIES.receipt.promptFocus,
  payment: STRATEGIES.payment.promptFocus,
  bill: STRATEGIES.bill.promptFocus,
  payslip: STRATEGIES.payslip.promptFocus,
  settlement_slip: STRATEGIES.settlement_slip.promptFocus,
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
 * Context for building a cloud extraction prompt with optional arbitration data.
 */
export interface CloudPromptContext {
  /** Heuristic/model-predicted document type, defaults to "unknown". */
  predictedType?: DocumentType;
  /** Fields missing from local extraction that cloud should prioritize. */
  missingFields?: Array<'vendor' | 'invoiceNumber' | 'invoiceDate' | 'totalAmount' | 'currency'>;
  /** Fields where rules and local model disagreed, keyed by field name. */
  conflicts?: Partial<
    Record<
      'invoiceNumber' | 'invoiceDate' | 'totalAmount' | 'currency',
      {
        rulesValue: string | number | null;
        localLlmValue: string | number | null;
      }
    >
  >;
}

/**
 * Builds the cloud extraction prompt for a given context.
 * Combines FINANCIAL_BASE_PROMPT with per-type focus lines and optional
 * arbitration context (conflicts / missing fields) for refine_jobs Phase 2.
 * Invoice returns the base prompt verbatim (no behavior change).
 * @param ctx Optional context with predictedType, missingFields, conflicts
 * @returns Prompt text
 */
export function buildCloudExtractionPrompt(ctx: CloudPromptContext = {}): string {
  const typeKey: DocumentType = ctx.predictedType ?? 'unknown';
  const parts: string[] = [
    FINANCIAL_BASE_PROMPT,
    CLOUD_TYPE_FOCUS[typeKey] ?? CLOUD_TYPE_FOCUS.unknown,
  ];

  if (typeKey !== 'unknown') {
    parts.push(
      `Note: Upstream heuristic suggested "${typeKey}", but verify against the text and change documentType if the text clearly shows another type.`
    );
  }

  if (ctx.conflicts && Object.keys(ctx.conflicts).length > 0) {
    const conflictLines = Object.entries(ctx.conflicts).map(
      ([field, vals]) =>
        `- ${field}: rules=${JSON.stringify(vals?.rulesValue ?? null)} vs local_model=${JSON.stringify(vals?.localLlmValue ?? null)}`
    );
    parts.push(
      `Arbitration context (local stages disagreed; verify directly from source text):\n${conflictLines.join('\n')}`
    );
  } else if (ctx.missingFields && ctx.missingFields.length > 0) {
    parts.push(`Priority missing fields to inspect carefully: ${ctx.missingFields.join(', ')}.`);
  }

  parts.push('Document text:');
  return parts.join('\n\n');
}

/**
 * Builds the ultra-compact local Flan-T5 prompt for the 5 core ExtractedData fields.
 * Designed for LaMini-Flan-T5-77M's ~512-token input budget: short instruction +
 * one 1-shot example + truncated text snippet.
 * @param text Raw document text
 * @param oneShotExample Compact "Text: ...\nJSON: ..." example for the document type
 * @param maxChars Max characters of text to include (default 1400)
 * @returns Prompt text
 */
export function buildLocalFlanPrompt(
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
