import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const baseEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in baseEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    process.env[key] = value;
  }
  vi.resetModules();
});

async function importConfig(
  overrides: Record<string, string | undefined>
): Promise<typeof import('../config.js')> {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../config.js');
}

const testEnv: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

// config.ocrLangs is imported ONLY through importConfig (no bare import of
// ./ocr.service.js or ./config.js anywhere in this file before these tests,
// otherwise vi.resetModules() stops re-evaluating config.js with the new env).
describe('ocrLangs (config.ocrLangs from OCR_LANGS)', () => {
  it('defaults to eng+deu when OCR_LANGS is unset', async () => {
    const mod = await importConfig({ ...testEnv, OCR_LANGS: undefined });
    expect(mod.config.ocrLangs).toBe('eng+deu');
  });

  it('accepts eng+fra+ita', async () => {
    const mod = await importConfig({ ...testEnv, OCR_LANGS: 'eng+fra+ita' });
    expect(mod.config.ocrLangs).toBe('eng+fra+ita');
  });

  it('drops unknown codes (eng+xyz -> eng)', async () => {
    const mod = await importConfig({ ...testEnv, OCR_LANGS: 'eng+xyz' });
    expect(mod.config.ocrLangs).toBe('eng');
  });

  it('falls back to eng+deu when empty or all-invalid', async () => {
    const empty = await importConfig({ ...testEnv, OCR_LANGS: '' });
    expect(empty.config.ocrLangs).toBe('eng+deu');
    const invalid = await importConfig({ ...testEnv, OCR_LANGS: 'xyz,zzz' });
    expect(invalid.config.ocrLangs).toBe('eng+deu');
  });

  it('adds eng in front when a non-eng language is given', async () => {
    const mod = await importConfig({ ...testEnv, OCR_LANGS: 'fra' });
    expect(mod.config.ocrLangs).toBe('eng+fra');
  });

  it('keeps eng first and deduplicates', async () => {
    const mod = await importConfig({ ...testEnv, OCR_LANGS: 'deu+eng+deu' });
    expect(mod.config.ocrLangs).toBe('eng+deu');
  });
});

describe('ocr.service — unit skips heavy deps', () => {
  it('module exports ocrBuffer and terminateOcr', async () => {
    const mod = await import('./ocr.service.js');
    expect(typeof mod.ocrBuffer).toBe('function');
    expect(typeof mod.terminateOcr).toBe('function');
  });

  it('module is importable without side effects', async () => {
    const mod2 = await import('./ocr.service.js');
    expect(mod2).toBeDefined();
  });
});
