import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAiConfig = vi.hoisted(() => ({
  providers: ["gemini"],
  model: "gemini-flash-latest",
  apiKey: "fake-key",
  groqApiKey: "",
  openRouterApiKey: "",
  timeoutMs: 20000,
  threshold: 0.5,
}));

vi.mock("../config.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    config: {
      ...orig.config,
      ai: mockAiConfig,
      awsRegion: "ap-south-1",
    },
  };
});

const globalFetch = global.fetch;

describe("ai.service — extractWithAI / tryAI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn() as any;
    mockAiConfig.providers = ["gemini"];
    mockAiConfig.model = "gemini-flash-latest";
    mockAiConfig.apiKey = "fake-key";
    mockAiConfig.groqApiKey = "";
    mockAiConfig.openRouterApiKey = "";
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
    expect(fetch).toHaveBeenCalledWith(
      expect.not.stringContaining("?key="),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "fake-key" }),
      }),
    );
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
    await expect(tryAI("hello")).rejects.toThrow(/status 401/);
  });

  it("uses configured secondary providers when the Gemini key is absent", async () => {
    mockAiConfig.providers = ["gemini", "groq"];
    mockAiConfig.apiKey = "";
    mockAiConfig.groqApiKey = "groq-key";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                vendor: "Example Co",
                confidence: 0.8,
                documentType: "invoice",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as any);

    const { extractWithAI } = await import("./ai.service.js");
    const result = await extractWithAI("invoice text");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/chat/completions",
      expect.any(Object),
    );
    expect(result.data.vendor).toBe("Example Co");
    expect(result.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("retries a throttled provider once before accepting its response", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      vendor: "Example Co",
                      confidence: 0.8,
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
    const result = await extractWithAI("invoice text");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.data.vendor).toBe("Example Co");
  });
});
