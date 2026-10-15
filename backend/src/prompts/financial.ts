/**
 * prompts/financial.ts — Extraction prompt for financial documents.
 */

export const FINANCIAL_PROMPT = `You are a generic parser for financial documents (invoice/receipt/payslip/payment/bill/settlement_slip). Decide documentType from heading/layout.

Return ONLY JSON, no markdown:
{"vendor":string|null,"invoiceNumber":string|null,"invoiceDate":string|null,"totalAmount":number|null,"currency":string|null,"confidence":number,"notes":string|null,"documentType":"invoice|receipt|payment|bill|payslip|settlement_slip|other|unknown"}

Extraction rules:
- vendor: Return only the actual seller, merchant, service provider, utility, employer, or payment sender that issued this document. Use a clearly identified business name/logo or an explicit Seller/From/Merchant/Provider label. Do not guess from nearby text.
- vendor: Never return document section headings, field labels, payment methods/options, account/payment instructions, bank details, invoice/receipt/bill titles, customer/bill-to names, addresses, or amounts. In particular, text such as "5. PAYMENT OPTIONS" is a heading, not a vendor. If the issuer cannot be distinguished confidently, return null.
- invoiceNumber: Invoice No/#, Ref, Bill No, Receipt No, Transaction ID. Null if none.
- invoiceDate: Invoice/Date/Bill Date. Normalize to YYYY-MM-DD.
- totalAmount: FINAL due, not subtotal/tax. Pick LAST footer value; ignore Subtotal/Net/VAT. Strip ₹/Rs./€/$/,.
- currency: ₹/Rs.->INR, €->EUR, $->USD
- documentType: invoice (INVOICE/RECHNUNG), receipt (Bill No/GRAND TOTAL narrow), payment (Payment Status), bill, payslip, settlement_slip, other/unknown. Infer from heading/layout; never hallucinate.

Rules: Null when evidence is missing or ambiguous; never choose the nearest plausible text just to fill a field. totalAmount is a number; confidence is 0-1 for the extraction as a whole.

Text follows:`;
