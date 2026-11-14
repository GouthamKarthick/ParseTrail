/**
 * utils/regex-utils.ts — Deterministic regex extraction helpers.
 *
 * Every rule here is pure and model-free: these are the "rules-first" rungs of
 * the extraction cascade and the floor that runLocalLLMExtraction falls back to
 * when Flan-T5 emits unparseable output. Kept out of transformers.service.ts so
 * the rules are testable and importable without pulling in the model loader.
 */

import { detectCurrencyFromText } from './currency.js';

const MONTH_RE =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';

const MONTH_NUM: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  sept: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/**
 * Resolves a month name or abbreviation to its two-digit number.
 * @param raw Month token from document text
 * @returns "01"-"12" or null when unrecognized
 */
function monthNum(raw: string): string | null {
  return MONTH_NUM[raw.toLowerCase()] ?? null;
}

const GENERIC_HEADING =
  /^(invoice|invoices|receipt|receipts|bill|bills|payslip|pay[\s-]?slip|pay[\s-]?stub|payment(\s*advice)?|template|sample|tax\s*invoice|statement|annexure|form|application|print|download|brought to you|powered by|copyright|page \d|thank you|thanks|dear )/i;
const GENERIC_TAIL =
  /(receipt|invoice|bill|payslip|stub|slip|statement|form|template|sample|details|information|purposes|unit|signatures|date|day)$/i;
const LABEL_BIGRAM =
  /^(employer|employee|company|business|client|customer|tenant|landlord|donor|payer|payee|provider)\s+(name|id|no|number|address|details|information|phone|email)$/i;
const GENERIC_ANYWHERE = /\b(template|sample|specimen|example|draft|placeholder|print|download)\b/i;
const VENDOR_SECTION_HEADING =
  /^(?:\d+(?:\.\d+)*[.)]?\s*)?(?:payment options?|payment methods?|payment terms?|terms and conditions|bank details|banking details|account details|tax details|invoice details|billing details|customer details|supplier details)\b/i;
const VENDOR_LABEL =
  /^(date|total|amount|invoice|receipt|bill|payment|balance|due|from|to|no|number|customer|client|vendor|gstin|pan|cin|phone|email|address|billed|ship(ped|ping)?|sold|remit(tance)?)\b/i;
const VENDOR_PREFIX =
  /^(name|vendor|company|customer|client|bill to|ship to|from|attn|attention)\s*:?\s+/i;

const INVNUM_STOP = new Set([
  'DATE',
  'TOTAL',
  'AMOUNT',
  'INVOICE',
  'NUMBER',
  'NO',
  'BILL',
  'RECEIPT',
  'CUSTOMER',
  'CLIENT',
  'VENDOR',
  'COMPANY',
  'NAME',
  'ADDRESS',
  'PHONE',
  'EMAIL',
  'PAID',
  'DUE',
  'BALANCE',
  'FROM',
  'TO',
  'REF',
]);

/**
 * Checks whether a comma-stripped digit run looks like an ID/reference, not money.
 * Bank and utility statements print long zero-padded account numbers that sit
 * next to amount labels; a bare integer that long is far more likely to be one.
 * @param digits Comma-stripped candidate
 * @returns True if ID-like
 */
function isIdLike(digits: string): boolean {
  const bare = digits.replace(/,/g, '');
  if (bare.includes('.')) return false;
  return bare.length >= 7;
}

/**
 * Fallback amount scan: last currency-prefixed number, else keyword-anchored
 * (TOTAL DUE / GRAND TOTAL / Amount / NET PAY) with optional parenthesized
 * symbol — e.g. settlement slips print "NET PAY (₹) : 55,621.00".
 * @param text Document text
 * @returns Amount or null
 */
export function extractAmountFallback(text: string): number | null {
  const amounts = [...text.matchAll(/(?:₹|Rs\.?|\$|€|£)\s*([0-9,]+(?:\.\d{1,2})?)/g)]
    .map(m => m[1].replace(/,/g, ''))
    .filter(d => !isIdLike(d));
  if (amounts.length) {
    const n = Number(amounts[amounts.length - 1]);
    if (!isNaN(n)) return n;
  }
  const plainM = [
    ...text.matchAll(
      /(?:TOTAL DUE|GRAND TOTAL|Amount|NET PAY)\s*\(?(?:₹|Rs\.?|\$|€|£)?\)?\s*[:\-]?\s*([0-9,]+(?:\.\d{1,2})?)/gi
    ),
  ]
    .map(m => m[1].replace(/,/g, ''))
    .filter(d => !isIdLike(d));
  if (plainM.length) {
    const n = Number(plainM[plainM.length - 1]);
    if (!isNaN(n)) return n;
  }
  const codeAmount = [...text.matchAll(/\b(?:INR|USD|EUR|GBP)\s+([0-9][0-9,.]*)/gi)]
    .map(m => m[1].replace(/,/g, '').replace(/\s/g, ''))
    .filter(d => !isIdLike(d));
  if (codeAmount.length) {
    const n = Number(codeAmount[codeAmount.length - 1]);
    if (!isNaN(n)) return n;
  }
  return null;
}

/**
 * Fallback date scan: ISO, DD/MM/YYYY, "3rd September 2026" / "03 Sep 2026" /
 * "September 3, 2026", then legacy year-less Aug.
 * @param text Document text
 * @returns YYYY-MM-DD or null
 */
export function extractDateFallback(text: string): string | null {
  const iso = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso?.[1]) return iso[1];
  const slash = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (slash) return `${slash[3]}-${slash[2]}-${slash[1]}`;
  const dmy = text.match(
    new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-]+(${MONTH_RE})\\b[\\s\\-,]*?(\\d{4})`, 'i')
  );
  if (dmy) {
    const dd = Number(dmy[1]);
    const mm = monthNum(dmy[2]);
    if (mm && dd >= 1 && dd <= 31) return `${dmy[3]}-${mm}-${String(dd).padStart(2, '0')}`;
  }
  const mdy = text.match(
    new RegExp(`\\b(${MONTH_RE})\\b[\\s\\-,]+(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-,]+(\\d{4})`, 'i')
  );
  if (mdy) {
    const dd = Number(mdy[2]);
    const mm = monthNum(mdy[1]);
    if (mm && dd >= 1 && dd <= 31) return `${mdy[3]}-${mm}-${String(dd).padStart(2, '0')}`;
  }
  const thisYear = String(new Date().getFullYear());
  const augDay = text.match(/(\d{1,2})\s+Aug/i);
  if (augDay) return `${thisYear}-08-${augDay[1].padStart(2, '0')}`;
  const augFull = text.match(/(\d{1,2})-Aug-(\d{4})/i);
  if (augFull) return `${augFull[2]}-08-${augFull[1].padStart(2, '0')}`;
  return null;
}

/**
 * Clean a vendor candidate line by removing prefixes and generic labels.
 * @param line Candidate line
 * @returns Clean vendor or null
 */
export function cleanVendorCandidate(line: string | undefined): string | null {
  let v = (line ?? '').trim().slice(0, 120);
  if (/[\x00-\x1f]/.test(v)) return null;
  v = v.replace(VENDOR_PREFIX, '').trim();
  if (v.length < 3 || /^[\d\s\-/#.,]+$/.test(v)) return null;
  if (/^[^a-z0-9]/i.test(v)) return null;
  if (VENDOR_SECTION_HEADING.test(v)) return null;
  if (/_/.test(v) || /^[A-Z] [A-Z]{2,}$/.test(v)) return null;
  if (GENERIC_HEADING.test(v) || VENDOR_LABEL.test(v)) return null;
  const words = v
    .replace(/['’]s\b/gi, '')
    .replace(/[^a-z\s]/gi, '')
    .trim();
  if (/:$/.test(v)) return null;
  if (GENERIC_TAIL.test(words) || GENERIC_ANYWHERE.test(words)) return null;
  if (LABEL_BIGRAM.test(words)) return null;
  if (v.endsWith('.') && v.length > 45) return null;
  return v;
}

/**
 * Finds the first vendor line in document text.
 * @param text Document text
 * @returns Vendor or null
 */
export function firstVendorLine(text: string): string | null {
  for (const ln of text.split('\n')) {
    const t = ln.trim();
    if (!t) continue;
    const v = cleanVendorCandidate(t.split('  ')[0].trim()) ?? cleanVendorCandidate(t);
    if (v) return v;
  }
  return null;
}

/**
 * Cleans invoice number capture: removes stop words, validates format.
 * @param raw Regex capture
 * @returns Clean number or null
 */
export function cleanInvoiceNumber(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v || INVNUM_STOP.has(v.toUpperCase())) return null;
  return v;
}

/**
 * Standalone invoice-number rule (Ref / Invoice No / Bill No).
 * @param text Document text
 * @returns Number or null
 */
export function extractInvoiceNumberFallback(text: string): string | null {
  const invM =
    text.match(/\bRef\b\s*[:#]?\s*([A-Z0-9\-\/]+)/i) ||
    text.match(/Invoice\s*(?:No\.?|Number|#)\s*[:#]?\s*([A-Z0-9\-\/]+)/i) ||
    text.match(/Bill\s*No\s*[:#]?\s*([A-Z0-9\-\/]+)/i);
  return cleanInvoiceNumber(invM?.[1]);
}

/**
 * Standalone currency rule (symbol presence).
 * @param text Document text
 * @returns Currency code or null
 */
export function extractCurrencyFallback(text: string): string | null {
  return detectCurrencyFromText(text);
}
