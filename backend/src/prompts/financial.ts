/**
 * prompts/financial.ts — Base extraction prompt for financial documents (cloud tier).
 *
 * Split from the old flat FINANCIAL_PROMPT: this is the shared schema + global rules
 * that every cloud prompt starts with. Per-type focus is appended by strategies.ts
 * via buildCloudExtractionPrompt; the local Flan-T5 tier gets its own ultra-short
 * prompt via buildLocalFlanPrompt.
 */

export const FINANCIAL_BASE_PROMPT = `You are a strict financial document extractor. Classify documentType and extract fields from OCR/PDF text.

Return ONLY valid JSON (no markdown, no prose):
{"vendor":string|null,"invoiceNumber":string|null,"invoiceDate":string|null,"totalAmount":number|null,"currency":string|null,"confidence":number,"notes":string|null,"documentType":"invoice|receipt|payment|bill|payslip|settlement_slip|other|unknown"}

Global rules:
1. Evidence & Null Policy: Extract ONLY from explicit evidence in the text. Never guess from nearby text to fill a field. Return null if missing or ambiguous. If the document is NOT financial (e.g. resume, article, letter), set documentType="other" and all extracted fields to null.
2. vendor: Extract ONLY the issuing seller, merchant, service provider, utility, employer, or payment platform/sender—identified by header/logo/brand or explicit "From/Seller/Merchant/Provider/Employer" labels. NEVER extract:
   - Section headings or numbered titles (e.g. "5. PAYMENT OPTIONS", "TERMS", "INVOICE", "RECEIPT")
   - Payment instructions, bank/IBAN/IFSC/UPI details, or payment methods
   - Customer / "Bill To" / "Ship To" / "Employee" names, addresses, or contact lines
3. invoiceDate: Normalize to YYYY-MM-DD. Prefer Issue/Transaction/Bill/Pay Date over Due Date or print timestamps. Resolve DD/MM vs MM/DD using document locale (e.g. INR/GSTIN/UK/AU -> DD/MM; US ZIP/state -> MM/DD). Return null if unparseable.
4. totalAmount: JSON number only (strip currency symbols and thousand separators; use "." for decimals). Must be the final payable/paid/net total—ignore subtotals, taxes, discounts, tendered cash, change due, or YTD totals unless no final total exists.
5. currency: 3-letter ISO-4217 code (e.g. ₹/Rs.->INR, €->EUR, £->GBP, $->USD unless locale cues like ABN/GST/AUD or UEN/SGD indicate AUD/SGD/CAD). Return null if no currency evidence exists.
6. confidence: 0.0 to 1.0 reflecting overall extraction reliability.
7. notes: Brief ambiguity/conflict note if any, else null.`;
