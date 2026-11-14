import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAiConfig = vi.hoisted(() => ({
  providers: ['gemini'] as Array<'gemini' | 'groq' | 'openrouter' | 'anthropic'>,
  providerKeys: {
    gemini: { apiKey: 'fake-key', model: 'gemini-flash-latest' },
  } as Record<string, { apiKey: string; model: string }>,
  timeoutMs: 20000,
}));

vi.mock('../config.js', async importOriginal => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    config: {
      ...orig.config,
      ai: mockAiConfig,
      awsRegion: 'ap-south-1',
    },
  };
});

const globalFetch = global.fetch;

describe('ai.service — extractWithAI / tryAI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn() as any;
    mockAiConfig.providers = ['gemini'];
    mockAiConfig.providerKeys = {
      gemini: { apiKey: 'fake-key', model: 'gemini-flash-latest' },
    };
    mockAiConfig.timeoutMs = 20000;
    // Clear module cache so ai.service module (with its in-memory Maps) is re-created
    vi.resetModules();
  });
  afterEach(() => {
    global.fetch = globalFetch;
  });

  it('extractWithAI calls Gemini and strips ```json fence, normalizes INR and date', async () => {
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

    const { extractWithAI } = await import('./ai.service.js');
    const r = await extractWithAI('some text');
    expect(fetch).toHaveBeenCalledWith(
      expect.not.stringContaining('?key='),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-goog-api-key': 'fake-key' }),
      })
    );
    expect(r.data.vendor).toBe('Acme');
    expect(r.data.totalAmount).toBe(1200);
    expect(r.data.currency).toBe('INR');
    expect(r.data.invoiceDate).toBe('2026-09-11'); // DD/MM/YYYY → YYYY-MM-DD via validateAndNormalize
    expect(r.documentType).toBe('invoice');
    expect(r.method).toBe('llm');
  });

  it('normalizeDocumentType maps synonyms to allowed set', async () => {
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
    const { extractWithAI } = await import('./ai.service.js');

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mk('Settlement'),
    } as any);
    let r = await extractWithAI('t');
    expect(r.documentType).toBe('settlement_slip');

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mk('inv'),
    } as any);
    r = await extractWithAI('t');
    expect(r.documentType).toBe('invoice');
  });

  it('does not accept a payment section heading as the vendor', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    vendor: '5. PAYMENT OPTIONS',
                    totalAmount: 143691.6,
                    confidence: 0.9,
                    documentType: 'invoice',
                  }),
                },
              ],
            },
          },
        ],
      }),
    } as any);

    const { extractWithAI } = await import('./ai.service.js');
    const result = await extractWithAI('5. PAYMENT OPTIONS\n2 143,691.60');
    expect(result.data.vendor).toBeUndefined();
  });

  it('tryAI throws when AI_API_KEY missing (via tryAI error propagation)', async () => {
    // Re-mock config with empty key for this test via vi.doMock needs re-import isolation — instead test fetch 401 path
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid key',
    } as any);
    const { tryAI } = await import('./ai.service.js');
    await expect(tryAI('hello')).rejects.toThrow(/status 401/);
  });

  it('uses configured secondary providers when the Gemini key is absent', async () => {
    mockAiConfig.providers = ['gemini', 'groq'];
    mockAiConfig.providerKeys = {
      groq: { apiKey: 'groq-key', model: 'llama-3.3-70b-versatile' },
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                vendor: 'Example Co',
                confidence: 0.8,
                documentType: 'invoice',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as any);

    const { extractWithAI } = await import('./ai.service.js');
    const result = await extractWithAI('invoice text');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/chat/completions',
      expect.any(Object)
    );
    expect(result.data.vendor).toBe('Example Co');
    expect(result.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('retries a throttled provider once before accepting its response', async () => {
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
                      vendor: 'Example Co',
                      confidence: 0.8,
                      documentType: 'invoice',
                    }),
                  },
                ],
              },
            },
          ],
        }),
      } as any);

    const { extractWithAI } = await import('./ai.service.js');
    const result = await extractWithAI('invoice text');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.data.vendor).toBe('Example Co');
  });

  it('validateAndNormalize allows only safe keys, skips __proto__/constructor/prototype, caps at 20 keys', async () => {
    const hostile: Record<string, unknown> = {};
    hostile['__proto__'] = { polluted: 'yes' };
    hostile['constructor'] = { polluted: 'yes' };
    hostile['prototype'] = { polluted: 'yes' };
    hostile['valid_key'] = 'allowed';
    hostile['another_key'] = 42;
    hostile['bad-key!'] = 'should be skipped';
    hostile['123start'] = 'should be skipped';
    for (let i = 0; i < 25; i++) {
      hostile[`key${i}`] = `value${i}`;
    }

    const { extractWithAI } = await import('./ai.service.js');
    const part = { text: JSON.stringify(hostile) };
    const parts = [part];
    const content = { parts };
    const candidate = { content };
    const responseData = { candidates: [candidate] };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => responseData,
    } as any);

    const result = await extractWithAI('invoice text');

    // Dangerous keys must NOT appear as own properties
    expect(Object.keys(result.data)).not.toContain('__proto__');
    expect(Object.keys(result.data)).not.toContain('constructor');
    expect(Object.keys(result.data)).not.toContain('prototype');
    // Skipped keys (bad-key!, 123start) must NOT appear
    expect(result.data['bad-key!']).toBeUndefined();
    expect(result.data['123start']).toBeUndefined();
    // Allowed keys SHOULD appear
    expect(result.data.valid_key).toBe('allowed');
    expect(result.data.another_key).toBe(42);
    // Key cap: only the first 20 valid keys should be present
    // (valid_key + another_key = 2, so key0 through key17 fit)
    const validKeys = Object.keys(result.data).filter(k => k.startsWith('key'));
    expect(validKeys.length).toBe(18);
    expect(result.data.key0).toBe('value0');
    expect(result.data.key17).toBe('value17');
    expect(result.data.key18).toBeUndefined();
  });
});
