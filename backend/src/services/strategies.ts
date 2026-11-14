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
import { FINANCIAL_PROMPT } from '../prompts/financial.js';

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
  if (t === 'invoice' || !STRATEGIES[t]) return FINANCIAL_PROMPT;
  return `${FINANCIAL_PROMPT}\n\n${STRATEGIES[t].promptFocus}`;
}
