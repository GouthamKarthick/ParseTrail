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
    vi.useRealTimers();
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

  it('provider 1 returns 503 -> provider 2 used and result returned', async () => {
    mockAiConfig.providers = ['gemini', 'groq'];
    mockAiConfig.providerKeys = {
      gemini: { apiKey: 'fake-key', model: 'gemini-flash-latest' },
      groq: { apiKey: 'groq-key', model: 'llama-3.3-70b-versatile' },
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      } as any)
      .mockResolvedValueOnce({
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
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.groq.com/openai/v1/chat/completions',
      expect.any(Object)
    );
    expect(result.data.vendor).toBe('Example Co');
  });

  it('401 from provider 1 skips it for 10 minutes, then retries after cooldown', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    mockAiConfig.providers = ['gemini', 'groq'];
    mockAiConfig.providerKeys = {
      gemini: { apiKey: 'fake-key', model: 'gemini-flash-latest' },
      groq: { apiKey: 'groq-key', model: 'llama-3.3-70b-versatile' },
    };

    // Call 1: gemini 401 -> skipped, groq succeeds
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'invalid key' } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  vendor: 'Groq Co',
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
    let r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Groq Co');

    // Call 2 immediately: gemini skipped (auth cooldown), groq again
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                vendor: 'Groq Co 2',
                confidence: 0.8,
                documentType: 'invoice',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as any);
    r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Groq Co 2');
    expect(fetch).toHaveBeenCalledTimes(3); // call1: 2 fetches, call2: 1 fetch

    // Advance past 10-minute cooldown -> gemini tried again
    vi.setSystemTime(now + 10 * 60 * 1000 + 1000);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    vendor: 'Gemini Back',
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
    r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Gemini Back');

    vi.useRealTimers();
  });

  it('three consecutive 429s trigger 2-minute cooldown, success resets counter', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    mockAiConfig.providers = ['gemini', 'groq'];
    mockAiConfig.providerKeys = {
      gemini: { apiKey: 'fake-key', model: 'gemini-flash-latest' },
      groq: { apiKey: 'groq-key', model: 'llama-3.3-70b-versatile' },
    };

    const gemini429 = {
      ok: false,
      status: 429,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as any;
    const groqOk = {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                vendor: 'Groq Co',
                confidence: 0.8,
                documentType: 'invoice',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as any;

    // Call 1: gemini 429 (count=1), groq succeeds
    vi.mocked(fetch).mockResolvedValueOnce(gemini429).mockResolvedValueOnce(groqOk);
    const { extractWithAI } = await import('./ai.service.js');
    let r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Groq Co');

    // Call 2: gemini 429 (count=2), groq succeeds
    vi.mocked(fetch).mockResolvedValueOnce(gemini429).mockResolvedValueOnce(groqOk);
    r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Groq Co');

    // Call 3: gemini 429 (count=3 -> cooldown 2 min), groq succeeds
    vi.mocked(fetch).mockResolvedValueOnce(gemini429).mockResolvedValueOnce(groqOk);
    r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Groq Co');

    // Call 4 immediately: gemini in cooldown, skipped, groq succeeds
    vi.mocked(fetch).mockResolvedValueOnce(groqOk);
    r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Groq Co');

    // Advance past 2-minute cooldown -> gemini retried; success resets counter
    vi.setSystemTime(now + 2 * 60 * 1000 + 1000);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    vendor: 'Gemini Back',
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
    r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Gemini Back');

    // Counter reset: next gemini 429 starts count at 1 again (not cooldown)
    vi.mocked(fetch).mockResolvedValueOnce(gemini429).mockResolvedValueOnce(groqOk);
    r = await extractWithAI('invoice text');
    expect(r.data.vendor).toBe('Groq Co');
    expect(fetch).toHaveBeenCalledTimes(10);

    vi.useRealTimers();
  });

  it('all providers fail -> throws the existing cloud-failed error', async () => {
    mockAiConfig.providers = ['gemini', 'groq'];
    mockAiConfig.providerKeys = {
      gemini: { apiKey: 'fake-key', model: 'gemini-flash-latest' },
      groq: { apiKey: 'groq-key', model: 'llama-3.3-70b-versatile' },
    };
    vi.mocked(fetch)
      .mockResolvedValue({
        ok: false,
        status: 503,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      } as any)
      .mockResolvedValue({
        ok: false,
        status: 503,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      } as any);

    const { extractWithAI } = await import('./ai.service.js');
    await expect(extractWithAI('invoice text')).rejects.toThrow(
      /No configured AI provider completed extraction|503/
    );
  });

  it('no log call contains the api key string', async () => {
    const loggerMod = (await import('../config/logger.js')).logger;
    const warnSpy = vi.spyOn(loggerMod, 'warn');
    const infoSpy = vi.spyOn(loggerMod, 'info');

    mockAiConfig.providers = ['gemini'];
    mockAiConfig.providerKeys = {
      gemini: { apiKey: 'super-secret-key-12345', model: 'gemini-flash-latest' },
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    vendor: 'Acme',
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
    await extractWithAI('invoice text');

    const allCalls = [...warnSpy.mock.calls, ...infoSpy.mock.calls].flat();
    const allLogText = allCalls.map(c => JSON.stringify(c)).join(' ');
    expect(allLogText).not.toContain('super-secret-key-12345');
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
