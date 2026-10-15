import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("fs/promises", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    default: {
      ...(orig.default as Record<string, unknown>),
      readFile: vi.fn(),
    },
    readFile: vi.fn(),
  };
});
vi.mock("./ocr.service.js", () => ({ ocrBuffer: vi.fn() }));
vi.mock("./ai.service.js", () => ({ tryAI: vi.fn() }));
vi.mock("./transformers.service.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    runLocalLLMExtraction: vi.fn(async () => ({
      data: {},
      confidence: 0,
      documentType: "invoice",
    })),
  };
});
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import fs from "fs/promises";
import { ocrBuffer } from "./ocr.service.js";
import { tryAI } from "./ai.service.js";
import { runLocalLLMExtraction } from "./transformers.service.js";
import { extract } from "./extraction.service.js";
import { config } from "../config.js";
const mockReadFile = vi.mocked(fs.readFile);
const mockOcr = vi.mocked(ocrBuffer);
const mockTryAI = vi.mocked(tryAI);
const mockLocal = vi.mocked(runLocalLLMExtraction);
const pngBuffer = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
function ocrText(t: string, c = 95, p = 1) {
  return { text: t, confidence: c, pages: p };
}
describe("extraction.service — Flan local -> Gemini", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (config as any).ai = { ...config.ai, apiKey: "", threshold: 0.5 };
    mockLocal.mockResolvedValue({
      data: {},
      confidence: 0,
      documentType: "invoice",
    });
  });
  it("Flan high confidence skips AI (local-llm)", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "Acme Corp\nInvoice Number: INV-123\nInvoice Date: 2024-02-01\nTotal 1300",
      ),
    );
    mockLocal.mockResolvedValue({
      data: {
        vendor: "Acme Corp",
        invoiceNumber: "INV-123",
        totalAmount: 1300,
        currency: "INR",
      },
      confidence: 0.72,
      documentType: "invoice",
    });
    const r = await extract(pngBuffer, { order: "model-first" });
    expect(r.data.invoiceNumber).toBe("INV-123");
    expect(r.method).toBe("local-llm");
    expect(mockTryAI).not.toHaveBeenCalled();
  });
  it("empty short -> unknown", async () => {
    (config as any).ai.apiKey = "";
    mockOcr.mockResolvedValue(ocrText("hi"));
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("unknown");
    expect(r.method).toBe("local-llm");
  });
  it("receipt narrow via Flan", async () => {
    mockLocal.mockResolvedValue({
      data: { vendor: "Chai Point", invoiceNumber: "CP-99", totalAmount: 200 },
      confidence: 0.6,
      documentType: "receipt",
    });
    mockOcr.mockResolvedValue(
      ocrText("Chai Point\nBill No: CP-99\nGrand Total Rs 200"),
    );
    const r = await extract(pngBuffer, { order: "model-first" });
    expect(r.documentType).toBe("receipt");
    expect(mockLocal).toHaveBeenCalled();
  });
  it("scanned PDF triggers ocrBuffer pdf", async () => {
    const pdf = Buffer.from("%PDF-1.4\n% empty");
    mockOcr.mockResolvedValue(ocrText("Invoice Number: SCAN-1 Total 99"));
    mockLocal.mockResolvedValue({
      data: { invoiceNumber: "SCAN-1" },
      confidence: 0.6,
      documentType: "invoice",
    } as any);
    const r = await extract(pdf);
    expect(mockOcr).toHaveBeenCalled();
    expect(r.data.invoiceNumber).toBe("SCAN-1");
  });
  it("gate high local confidence skips AI even with key", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(
      ocrText("Invoice Number: INV-999 2024-02-01 Total 500 Vendor TestCo"),
    );
    mockLocal.mockResolvedValue({
      data: { vendor: "TestCo", invoiceNumber: "INV-999", totalAmount: 500 },
      confidence: 0.8,
      documentType: "invoice",
    });
    mockTryAI.mockResolvedValue({
      data: { vendor: "AI Vendor" },
      confidence: 0.99,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.9,
    } as any);
    const r = await extract(pngBuffer);
    expect(r.data.vendor).not.toBe("AI Vendor");
    expect(mockTryAI).not.toHaveBeenCalled();
  });
  it("low local confidence calls AI and prefers AI", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(
      ocrText(
        "hello world invoice test with many words to ensure Type detection passes for invoice and total amount",
      ),
    );
    mockLocal.mockResolvedValue({
      data: {},
      confidence: 0.1,
      documentType: "invoice",
    });
    mockTryAI.mockResolvedValue({
      data: { vendor: "AI Vendor", invoiceNumber: "AI-123", totalAmount: 999 },
      confidence: 0.9,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.88,
    } as any);
    const r = await extract(pngBuffer);
    expect(mockTryAI).toHaveBeenCalled();
    expect(r.data.vendor).toBe("AI Vendor");
    expect(r.method).toBe("llm");
  });
  it("merges Flan+AI when Flan partial", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(ocrText("Acme Corp"));
    mockLocal.mockResolvedValue({
      data: { vendor: "Acme Corp" },
      confidence: 0.3,
      documentType: "invoice",
    });
    mockTryAI.mockResolvedValue({
      data: { vendor: "Acme Corp", totalAmount: 123.45, currency: "INR" },
      confidence: 0.6,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.7,
    } as any);
    const r = await extract(pngBuffer);
    expect(r.data.vendor).toBe("Acme Corp");
  });
  it("file path uses readFile", async () => {
    mockReadFile.mockResolvedValue(pngBuffer as any);
    mockOcr.mockResolvedValue(ocrText("Invoice Number: PATH-1 Total 10"));
    mockLocal.mockResolvedValue({
      data: { invoiceNumber: "PATH-1" },
      confidence: 0.6,
      documentType: "invoice",
    } as any);
    const r = await extract("/tmp/fake.png" as any);
    expect(mockReadFile).toHaveBeenCalledWith("/tmp/fake.png");
    expect(r.data.invoiceNumber).toBe("PATH-1");
  });
  it("currency via Flan", async () => {
    mockOcr.mockResolvedValue(ocrText("Invoice Number: C-1\nTotal: Rs 1000"));
    mockLocal.mockResolvedValue({
      data: { currency: "INR", totalAmount: 1000 },
      confidence: 0.6,
      documentType: "invoice",
    } as any);
    let r = await extract(pngBuffer);
    expect(r.data.currency).toBe("INR");
  });
  it("records heuristic-detect + local-llm attempts on short-circuit", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "Acme Corp\nInvoice Number: INV-123\nInvoice Date: 2024-02-01\nTotal 1300",
      ),
    );
    mockLocal.mockResolvedValue({
      data: {
        vendor: "Acme Corp",
        invoiceNumber: "INV-123",
        totalAmount: 1300,
        currency: "INR",
      },
      confidence: 0.72,
      documentType: "invoice",
    });
    const r = await extract(pngBuffer, { order: "model-first" });
    expect(r.attempts.map((a) => (a as { method: string }).method)).toEqual([
      "heuristic-detect",
      "local-llm",
    ]);
    expect((r.attempts[1] as { succeeded: boolean }).succeeded).toBe(true);
    expect(
      (r.attempts[1] as { fallbackReason?: string }).fallbackReason,
    ).toBeUndefined();
  });
  it("records failed local attempt with fallback reason on escalation", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(
      ocrText(
        "hello world invoice test with many words to ensure Type detection passes for invoice and total amount",
      ),
    );
    mockLocal.mockResolvedValue({
      data: {},
      confidence: 0.1,
      documentType: "invoice",
    });
    mockTryAI.mockResolvedValue({
      data: { vendor: "AI Vendor", invoiceNumber: "AI-123", totalAmount: 999 },
      confidence: 0.9,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.88,
    } as any);
    const r = await extract(pngBuffer, { order: "model-first" });
    const methods = r.attempts.map((a) => (a as { method: string }).method);
    expect(methods).toEqual(["heuristic-detect", "local-llm", "llm"]);
    expect(
      (r.attempts[1] as { fallbackReason?: string }).fallbackReason,
    ).toMatch(/escalating to cloud/);
  });
  it("rules-first short-circuits complete docs without cloud", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(
      ocrText("Acme Corp\nInvoice No: R-1\nDate: 2024-02-01\nTotal: $500"),
    );
    const r = await extract(pngBuffer, { order: "rules-first" });
    expect(r.method).toBe("rule-based");
    expect(r.data.invoiceNumber).toBe("R-1");
    expect(mockTryAI).not.toHaveBeenCalled();
    expect(r.attempts.map((a) => (a as { method: string }).method)).toEqual([
      "heuristic-detect",
      "rule-based",
    ]);
  });
  it("cloud-only extraction bypasses local short-circuits for refinement", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(
      ocrText("Acme Corp\nInvoice No: R-1\nTotal: $500"),
    );
    mockLocal.mockResolvedValue({
      data: { vendor: "Acme Corp", invoiceNumber: "R-1", totalAmount: 500 },
      confidence: 0.8,
      documentType: "invoice",
    });
    mockTryAI.mockResolvedValue({
      data: {
        vendor: "Acme Corp",
        invoiceNumber: "R-1",
        invoiceDate: "2024-02-01",
        totalAmount: 500,
        currency: "USD",
      },
      confidence: 0.9,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.9,
    } as any);

    const result = await extract(pngBuffer, { cloudOnly: true });

    expect(mockLocal).not.toHaveBeenCalled();
    expect(mockTryAI).toHaveBeenCalledOnce();
    expect(result.data.invoiceDate).toBe("2024-02-01");
    expect(result.attempts.map((attempt) => attempt.method)).toEqual([
      "heuristic-detect",
      "llm",
    ]);
  });
  it("rules/model date conflict forces cloud escalation", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(
      ocrText(
        "Tata Power\nBill No: B-1\nBill Date: 18/07/2015\nTotal: Rs 2028.97",
      ),
    );
    mockLocal.mockResolvedValue({
      data: {
        vendor: "Tata Power",
        invoiceNumber: "B-1",
        invoiceDate: "2015-07-17",
        totalAmount: 2028.97,
        currency: "INR",
      },
      confidence: 0.9,
      documentType: "bill",
    } as any);
    mockTryAI.mockResolvedValue({
      data: {
        vendor: "Tata Power",
        invoiceDate: "2015-07-18",
        totalAmount: 2028.97,
      },
      confidence: 0.9,
      method: "llm",
      documentType: "bill",
      documentTypeConfidence: 0.88,
    } as any);
    const r = await extract(pngBuffer, { order: "model-first" });
    expect(mockTryAI).toHaveBeenCalled();
    expect(
      (r.attempts[1] as { fallbackReason?: string }).fallbackReason,
    ).toMatch(/disagree on invoiceDate/);
  });
  it("conflict keeps rules value and still returns local without cloud", async () => {
    (config as any).ai.apiKey = "";
    mockOcr.mockResolvedValue(
      ocrText(
        "Tata Power\nBill No: B-1\nBill Date: 18/07/2015\nTotal: Rs 2028.97",
      ),
    );
    mockLocal.mockResolvedValue({
      data: {
        vendor: "Tata Power",
        invoiceNumber: "B-1",
        invoiceDate: "2015-07-17",
        totalAmount: 2028.97,
        currency: "INR",
      },
      confidence: 0.9,
      documentType: "bill",
    } as any);
    const r = await extract(pngBuffer, { order: "model-first" });
    expect(r.data.invoiceDate).toBe("2015-07-18");
    expect(r.method).toBe("local-llm");
  });
  it("rules-first escalates sparse docs to cloud", async () => {
    (config as any).ai.apiKey = "fake-key";
    mockOcr.mockResolvedValue(
      ocrText(
        "hello world invoice test with many words to ensure Type detection passes for invoice and total amount",
      ),
    );
    mockLocal.mockResolvedValue({
      data: {},
      confidence: 0.1,
      documentType: "invoice",
    });
    mockTryAI.mockResolvedValue({
      data: { vendor: "AI Vendor", totalAmount: 999 },
      confidence: 0.9,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.88,
    } as any);
    const r = await extract(pngBuffer, { order: "rules-first" });
    expect(mockTryAI).toHaveBeenCalled();
    const methods = r.attempts.map((a) => (a as { method: string }).method);
    expect(methods[0]).toBe("heuristic-detect");
    expect(methods[1]).toBe("rule-based");
    expect((r.attempts[1] as { succeeded: boolean }).succeeded).toBe(false);
  });
  it("contract note light-detects as settlement_slip", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "National Stock Exchange\nContract Note cum Tax Invoice\nSettlement No 2025149\nTrade Date 05/08/2025\nNet amount payable Rs 12,400",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("settlement_slip");
  });
  it("utility bill with receipt-trap words light-detects as bill", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "Con Edison\nMeter readings\nTotal electricity 11 kWh\nTotal amount due $22.31\nPayment is due upon receipt of this bill",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("bill");
  });
  it("electricity invoice wording light-detects as bill, not invoice", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "EDF Energy\nElectricity invoice: £1,342.74\nPayment due date: 15 Feb 21\nSupply address: 68 Sample Way",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("bill");
  });
  it("zelle confirmation light-detects as payment, not receipt", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "SAMPLE ZELLE RECEIPTS\nTransaction Status Successful\nAmount Rs 931\nTransaction ID NX21080620583725743445941",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("payment");
  });
  it("rent receipt light-detects as payment", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "RECEIPT FOR RENT MONEY\nTenant paid $800 in cash for rent on 12 Main St\nMoney Received By landlord",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("payment");
  });
  it("plain invoice with due date but no utility stays invoice", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "Your Company Name\nInvoice # 12345\nDue date 02/01/2026\nTotal: $100.00",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("invoice");
  });
  it("pay stub / earnings statement variants light-detect as payslip", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "Sample Statement of Earnings\nEmployee Name:\nGross Pay\nNet Pay",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("payslip");
  });
  it("full and final statement light-detects as settlement_slip", async () => {
    mockOcr.mockResolvedValue(
      ocrText(
        "Full and Final Settlement Statement\nEmployee dues payable on exit\nNet Payable Rs 45,000\nNo other claims remain",
      ),
    );
    const r = await extract(pngBuffer);
    expect(r.documentType).toBe("settlement_slip");
  });
});
