import { describe, it, expect } from "vitest";
import {
  extractAmountFallback,
  extractDateFallback,
  cleanVendorCandidate,
  firstVendorLine,
  cleanInvoiceNumber,
  extractInvoiceNumberFallback,
  extractCurrencyFallback,
} from "../utils/regex-utils.js";
import { extractRulesOnly } from "./transformers.service.js";

describe("transformers — extractAmountFallback", () => {
  it("parses settlement slip NET PAY with parenthesized symbol", () => {
    const text =
      "EARNINGS MASTER (₹) AMOUNT (₹) DEDUCTION AMOUNT (₹)\nNET PAY (₹) : 55,621.00\nIN WORDS : Fifty Five Thousand";
    expect(extractAmountFallback(text)).toBe(55621);
  });
  it("ignores parenthesized symbols in table headers without NET PAY", () => {
    const text =
      "EARNINGS MASTER (₹) AMOUNT (₹) DEDUCTION AMOUNT (₹)\nGROSS EARNINGS 63,832.64 GROSS DEDUCTION 3,389.00";
    expect(extractAmountFallback(text)).toBeNull();
  });
  it("keeps existing Amount: pattern", () => {
    expect(extractAmountFallback("Item x\nAmount: 5380.8")).toBe(5380.8);
  });
  it("keeps existing TOTAL DUE with symbol", () => {
    expect(extractAmountFallback("TOTAL DUE $1,300.00")).toBe(1300);
  });
  it("keeps existing GRAND TOTAL with Rs", () => {
    expect(extractAmountFallback("Grand Total Rs 200")).toBe(200);
  });
  it("prefers last currency-prefixed number", () => {
    expect(extractAmountFallback("Subtotal ₹100\nTax ₹18\nTotal ₹118")).toBe(
      118,
    );
  });
  it("returns null when no amount present", () => {
    expect(extractAmountFallback("Hello world, no numbers here")).toBeNull();
  });
});

describe("transformers — extractDateFallback", () => {
  const scannedInvoice =
    "Sunrise Hardware & Tools .\n88 Market Street, Coimbatore 641001\nGSTIN: 33AAECS1234F178\nInvoice No: SH/2026/0456\nDate: 03 Sep 2026\nItem Qty Amount\nTotal: Rs. 5380.8";
  it("parses OCR short date from scanned invoice", () => {
    expect(extractDateFallback(scannedInvoice)).toBe("2026-09-03");
  });
  it("parses ordinal long date as printed on paper", () => {
    expect(extractDateFallback("Invoice Date: 3rd September 2026")).toBe(
      "2026-09-03",
    );
  });
  it("parses US month-first date", () => {
    expect(extractDateFallback("Dated September 3, 2026")).toBe("2026-09-03");
  });
  it("keeps ISO date priority", () => {
    expect(extractDateFallback("2026-08-14 due, Date: 03 Sep 2026")).toBe(
      "2026-08-14",
    );
  });
  it("keeps DD/MM/YYYY behavior", () => {
    expect(extractDateFallback("DOJ : 11/09/2025")).toBe("2025-09-11");
  });
  it("resolves year-less Aug to the current year", () => {
    const year = new Date().getFullYear();
    expect(extractDateFallback("Dated 15 Aug, payable soon")).toBe(
      `${year}-08-15`,
    );
  });
  it("does not mistake street address for a date", () => {
    expect(
      extractDateFallback("88 Market Street, Coimbatore 641001"),
    ).toBeNull();
  });
  it("returns null when no date present", () => {
    expect(extractDateFallback("Hello world, no dates here")).toBeNull();
  });
});

describe("transformers — null-precision guards", () => {
  it("rejects generic headings as vendor", () => {
    expect(cleanVendorCandidate("Invoice")).toBeNull();
    expect(cleanVendorCandidate("PAYMENT CONFIRMATION")).toBeNull();
    expect(cleanVendorCandidate("5. PAYMENT OPTIONS")).toBeNull();
    expect(cleanVendorCandidate("Payment Options")).toBeNull();
    expect(cleanVendorCandidate("DATE OF ISSUE:")).toBeNull();
    expect(cleanVendorCandidate("00001")).toBeNull();
    expect(cleanVendorCandidate("Sunrise Hardware & Tools .")).toBe(
      "Sunrise Hardware & Tools .",
    );
  });
  it("firstVendorLine skips headings to the first real line", () => {
    expect(
      firstVendorLine(
        "Invoice\nINVOICE NUMBER:\n\nYOUR COMPANY NAME\nClient name",
      ),
    ).toBe("YOUR COMPANY NAME");
    expect(
      firstVendorLine(
        "Zoomrx Healthcare Technology Solutions Private Limited\nRegistered Office",
      ),
    ).toBe("Zoomrx Healthcare Technology Solutions Private Limited");
  });
  it("strips label prefixes and control chars from vendor", () => {
    expect(cleanVendorCandidate("Name : MR. KUMAR")).toBe("MR. KUMAR");
    expect(cleanVendorCandidate("Bill To: Northwind Retail Ltd")).toBe(
      "Northwind Retail Ltd",
    );
    expect(cleanVendorCandidate("From Avery Design Studio")).toBe(
      "Avery Design Studio",
    );
    expect(cleanVendorCandidate("9\x1cABC\x1bDEF")).toBeNull();
    expect(cleanVendorCandidate("Fromage Ltd")).toBe("Fromage Ltd");
  });
  it("rejects heading tails, placeholders, and sentences as vendor", () => {
    expect(cleanVendorCandidate("DONATION RECEIPT")).toBeNull();
    expect(cleanVendorCandidate("PRINTABLE PAY STUB TEMPLATE")).toBeNull();
    expect(cleanVendorCandidate("Brought to you by")).toBeNull();
    expect(
      cleanVendorCandidate("On ____ (date), ____ (tenant name)"),
    ).toBeNull();
    expect(
      cleanVendorCandidate(
        "This document serves as a formal receipt for the payment received.",
      ),
    ).toBeNull();
    expect(cleanVendorCandidate("American Land Title Association")).toBe(
      "American Land Title Association",
    );
  });
  it("rejects label-word invoice numbers", () => {
    expect(cleanInvoiceNumber("DATE")).toBeNull();
    expect(cleanInvoiceNumber("Total")).toBeNull();
    expect(cleanInvoiceNumber("SH/2026/0456")).toBe("SH/2026/0456");
    expect(cleanInvoiceNumber("INV-2026-014")).toBe("INV-2026-014");
  });
  it("extractInvoiceNumberFallback anchors Ref to word boundary", () => {
    expect(extractInvoiceNumberFallback("Ref: ABC-123")).toBe("ABC-123");
    expect(
      extractInvoiceNumberFallback("carefully reviewed by accounts"),
    ).toBeNull();
    expect(extractInvoiceNumberFallback("Bill No: CP-99")).toBe("CP-99");
  });
  it("extractCurrencyFallback maps symbols", () => {
    expect(extractCurrencyFallback("Total ₹500")).toBe("INR");
    expect(extractCurrencyFallback("Total Rs. 500")).toBe("INR");
    expect(extractCurrencyFallback("Total $500")).toBe("USD");
    expect(extractCurrencyFallback("Total €500")).toBe("EUR");
    expect(extractCurrencyFallback("Total £500")).toBe("GBP");
    expect(extractCurrencyFallback("Total 500")).toBeNull();
  });
  it("extractAmountFallback skips ID-like runs and reads £", () => {
    expect(
      extractAmountFallback(
        "Payment amount\n2025009519 07.01.2021 GBP ************18.00*",
      ),
    ).toBeNull();
    expect(extractAmountFallback("Electricity invoice: £1,342.74")).toBe(
      1342.74,
    );
    expect(extractAmountFallback("Total $264,990,610.38")).toBe(264990610.38);
  });

  it("extractAmountFallback reads currency-code amounts", () => {
    expect(extractAmountFallback("Total INR 1,250.50")).toBe(1250.5);
    expect(extractAmountFallback("USD 24.99")).toBe(24.99);
  });
  it("extractRulesOnly composes all deterministic helpers", () => {
    const r = extractRulesOnly(
      "Sunrise Hardware & Tools .\nInvoice No: SH/2026/0456\nDate: 03 Sep 2026\nTotal: Rs. 5380.8",
      "invoice",
    );
    expect(r.data).toMatchObject({
      vendor: "Sunrise Hardware & Tools .",
      invoiceNumber: "SH/2026/0456",
      invoiceDate: "2026-09-03",
      totalAmount: 5380.8,
      currency: "INR",
    });
    expect(r.confidence).toBeCloseTo(0.85, 5);
  });
});
