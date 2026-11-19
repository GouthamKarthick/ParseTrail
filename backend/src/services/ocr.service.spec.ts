import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ocrBuffer } from './ocr.service.js';
import fs from 'fs';
import path from 'path';

const origExit = process.exit.bind(process);
let exitCalls: Array<unknown> = [];

function installExitSpy(): void {
  (process.exit as unknown) = ((code?: unknown) => {
    exitCalls.push(code);
    throw new Error(
      `process.exit must not be called during OCR tests; called with ${String(code)}`
    );
  }) as unknown as typeof process.exit;
}

function restoreExit(): void {
  process.exit = origExit;
}

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const baseEnv = { ...process.env };

afterEach(() => {
  restoreExit();
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

describe('ocr.service — bad documents must not kill the process', () => {
  // Resolve tessdata dynamically so the suite runs on any machine/CI.
  const backendDir = path.join(__dirname, '..');
  const envTessdata = process.env.TESSDATA_PATH;
  const defaultTessdata = path.join(backendDir, 'tessdata');
  const TESSDATA =
    (envTessdata && fs.existsSync(path.join(envTessdata, 'eng.traineddata'))
      ? envTessdata
      : fs.existsSync(path.join(defaultTessdata, 'eng.traineddata'))
        ? defaultTessdata
        : undefined) ?? '';

  const needsTessdata = Boolean(TESSDATA);

  beforeEach(() => {
    exitCalls = [];
    installExitSpy();
    if (needsTessdata) process.env.TESSDATA_PATH = TESSDATA;
  });

  afterEach(() => {
    restoreExit();
  });

  it('rejects on a corrupt PNG with valid magic bytes and does not exit the process', async () => {
    if (!needsTessdata) {
      console.log(
        'SKIP: tessdata/eng.traineddata not found; cannot exercise real tesseract worker'
      );
      return;
    }
    const corruptPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // valid PNG magic bytes
      Buffer.from('corrupt-png-body-that-is-not-a-valid-png-image'), // corrupt body
    ]);

    await expect(ocrBuffer(corruptPng, 'image/png')).rejects.toThrow(Error);
    expect(exitCalls).toEqual([]);
  });

  it('rejects on a broken-xref PDF (pdftoppm cannot rasterise) and does not exit the process', async () => {
    // Valid %PDF header but an invalid/corrupt xref that makes pdftoppm fail
    // (exit 99: "Wrong page range given") with zero pages.
    const brokenPdf = Buffer.from(
      '%PDF-1.4\n' +
        '% corrupt un-rasterizable pdf body\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        'trailer\n<< /Root 1 0 R >>\n' +
        'startxref\n0\n%%%%EOF\n'
    );

    await expect(ocrBuffer(brokenPdf, 'application/pdf')).rejects.toThrow(Error);
    expect(exitCalls).toEqual([]);
  });
});
