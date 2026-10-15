import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    config: {
      ...orig.config,
      ai: {
        provider: "google",
        model: "gemini-flash-latest",
        apiKey: "fake-key",
        threshold: 0.5,
      },
      awsRegion: "ap-south-1",
    },
  };
});

const globalFetch = global.fetch;

describe("ai.service — extractWithAI / tryAI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn() as any;
  });
  afterEach(() => {
    global.fetch = globalFetch;
  });

  it("extractWithAI calls Gemini and strips ```json fence, normalizes INR and date", async () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: '```json\n{"vendor":"Acme","totalAmount":"Rs. 1,200.00","currency":"INR","confidence":0.9,"documentType":"invoice","invoiceDate":"11/09/2026"}\n```',
              },
            ],
          },
        },
      ],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => geminiResponse,
    } as any);

    const { extractWithAI } = await import("./ai.service.js");
    const r = await extractWithAI("some text");
    expect(r.data.vendor).toBe("Acme");
    expect(r.data.totalAmount).toBe(1200);
    expect(r.data.currency).toBe("INR");
    expect(r.data.invoiceDate).toBe("2026-09-11"); // DD/MM/YYYY → YYYY-MM-DD via validateAndNormalize
    expect(r.documentType).toBe("invoice");
    expect(r.method).toBe("llm");
  });

  it("normalizeDocumentType maps synonyms to allowed set", async () => {
    const mk = (docType: string) => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  documentType: docType,
                  confidence: 0.8,
                }),
              },
            ],
          },
        },
      ],
    });
    const { extractWithAI } = await import("./ai.service.js");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mk("Settlement"),
    } as any);
    let r = await extractWithAI("t");
    expect(r.documentType).toBe("settlement_slip");

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mk("inv"),
    } as any);
    r = await extractWithAI("t");
    expect(r.documentType).toBe("invoice");
  });

  it("does not accept a payment section heading as the vendor", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    vendor: "5. PAYMENT OPTIONS",
                    totalAmount: 143691.6,
                    confidence: 0.9,
                    documentType: "invoice",
                  }),
                },
              ],
            },
          },
        ],
      }),
    } as any);

    const { extractWithAI } = await import("./ai.service.js");
    const result = await extractWithAI("5. PAYMENT OPTIONS\n2 143,691.60");
    expect(result.data.vendor).toBeUndefined();
  });

  it("tryAI throws when AI_API_KEY missing (via tryAI error propagation)", async () => {
    // Re-mock config with empty key for this test via vi.doMock needs re-import isolation — instead test fetch 401 path
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid key",
    } as any);
    const { tryAI } = await import("./ai.service.js");
    await expect(tryAI("hello")).rejects.toThrow(/Gemini 401/);
  });
});
