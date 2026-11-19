/**
 * services/ocr.service.ts — OCR via Tesseract and PDF rasterization.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { logger } from '../config/logger.js';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));

export interface OcrResult {
  text: string;
  confidence: number;
  pages: number;
}

let tesseractWorker: Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>> | null =
  null;
let workerDead = false;
let workerQueue = Promise.resolve();

async function serializeWorker<T>(operation: () => Promise<T>): Promise<T> {
  const result = workerQueue.then(operation);
  workerQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Marks the shared tesseract worker as unusable. The in-flight recognize()
 * promise has already been rejected; the next job will terminate this
 * worker and recreate it.
 * @returns void
 */
function markWorkerDead(): void {
  workerDead = true;
}

/**
 * Gets or creates Tesseract worker.
 * The worker language string comes from config.ocrLangs (env OCR_LANGS,
 * default eng+deu) instead of a hardcoded value, so EU languages are
 * opt-in via configuration. The `lang` hint is kept for signature
 * compatibility but no longer selects the worker language.
 * @param _lang Language hint (unused; config.ocrLangs is authoritative)
 * @returns Worker
 */
async function getWorker(_lang: string) {
  const langs = config.ocrLangs;
  if (tesseractWorker) {
    try {
      if (workerDead) {
        logger.warn('Recreating dead tesseract worker');
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const curLangs: string = (tesseractWorker as any)._langs ?? '';
        if (curLangs === langs) return tesseractWorker;
      }
      await tesseractWorker.terminate();
    } catch (error) {
      logger.warn('Tesseract worker termination failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    tesseractWorker = null;
    workerDead = false;
  }
  const { createWorker } = await import('tesseract.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker: any = await createWorker(langs, 1, {
    langPath: process.env.TESSDATA_PATH || path.resolve(here, '..', '..'),
    gzip: false,
    // Log OCR worker errors and mark the shared worker unusable so the
    // in-flight recognize() promise rejects normally instead of throwing an
    // uncaught exception that can kill the Node process. The next job will
    // terminate and recreate the worker.
    errorHandler: (error: unknown) => {
      logger.warn('Tesseract worker error', { error });
      markWorkerDead();
    },
  });
  worker._langs = langs;
  tesseractWorker = worker;
  return worker;
}

/**
 * Preprocesses image with sharp.
 * @param input Image buffer
 * @returns Processed buffer
 */
async function preprocessWithSharp(input: Buffer): Promise<Buffer> {
  try {
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default ?? sharpMod;
    const meta = await sharp(input).metadata();
    let s = sharp(input);
    if (meta.width && meta.width < 1200)
      s = s.resize({
        width: 1800,
        withoutEnlargement: false,
        kernel: 'lanczos3',
      });
    s = s.grayscale().normalize().sharpen({ sigma: 1.2 }).linear(1.1, -10);
    return await s.png().toBuffer();
  } catch (e) {
    logger.warn('sharp preprocess failed, using raw', {
      error: (e as Error).message,
    });
    return input;
  }
}

/**
 * OCRs a single image buffer.
 * @param imageBuffer Image buffer
 * @param hintLang Language hint
 * @returns OCR result
 */
async function ocrImageBuffer(imageBuffer: Buffer, hintLang: string): Promise<OcrResult> {
  const lang = hintLang || 'eng';
  const preprocessed = await preprocessWithSharp(imageBuffer);
  return serializeWorker(async () => {
    const worker = await getWorker(lang);
    let result: { data: { text: string; confidence: number } };
    try {
      result = await worker.recognize(preprocessed, {}, { text: true } as never);
    } catch (e) {
      // Tesseract rejects with a string message on unreadable input. Wrap it in a
      // normal Error so callers can catch it and the refine job is marked
      // failed/dead instead of crashing the process.
      throw new Error(String(e));
    }
    const { data } = result;
    const text = (data.text as string) || '';
    const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
    logger.debug('tesseract ocrImage', {
      lang,
      confidence,
      pages: 1,
      textLength: text.length,
    });
    return { text, confidence, pages: 1 };
  });
}

/**
 * Rasterizes PDF to PNG buffers.
 * @param pdfBuffer PDF buffer
 * @returns PNG buffers
 */
async function rasterizePdfToPngs(pdfBuffer: Buffer): Promise<Buffer[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parsetrail-raster-'));
  const tmpPdf = path.join(tmpDir, 'input.pdf');
  const tmpPrefix = path.join(tmpDir, 'page');
  try {
    await fs.writeFile(tmpPdf, pdfBuffer);
    try {
      await execFileAsync(
        'pdftoppm',
        ['-f', '1', '-l', String(config.ocrMaxPages), '-png', '-r', '200', tmpPdf, tmpPrefix],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
      );
      const files = await fs.readdir(tmpDir);
      const pngs = files.filter(f => f.startsWith('page') && f.endsWith('.png')).sort();
      const buffers: Buffer[] = [];
      for (const f of pngs) buffers.push(await fs.readFile(path.join(tmpDir, f)));
      if (buffers.length > 0) {
        logger.debug('pdftoppm rasterized', { pages: buffers.length });
        return buffers;
      }
    } catch (e) {
      logger.warn('PDF rasterization failed', {
        error: (e as Error).message,
      });
    }
    return [];
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (error) {
      logger.warn('Raster temp directory cleanup failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}

/**
 * OCRs buffer (image or PDF).
 * @param buffer File buffer
 * @param mime Mime type
 * @param hintLang Optional lang hint
 * @returns OCR result
 */
export async function ocrBuffer(
  buffer: Buffer,
  mime: string,
  hintLang?: string
): Promise<OcrResult> {
  const isPdf = mime === 'application/pdf' || buffer.subarray(0, 4).toString() === '%PDF';
  if (!isPdf) {
    const actualLang = hintLang ?? 'eng';
    return ocrImageBuffer(buffer, actualLang);
  }
  const pngs = await rasterizePdfToPngs(buffer);
  if (pngs.length === 0) {
    // Tesseract cannot read PDFs. If pdftoppm fails or returns no pages,
    // throw a normal Error so the refine job is marked failed/dead instead
    // of crashing the process.
    throw new Error('PDF rasterization returned no pages; document is not rasterizable');
  }
  let combined = '';
  let totalConf = 0;
  let pagesDone = 0;
  const toOcr = pngs.slice(0, config.ocrMaxPages);
  const langHint = hintLang ?? 'eng';
  for (const png of toOcr) {
    try {
      const r = await ocrImageBuffer(png, langHint);
      combined += (combined ? '\n\n' : '') + r.text;
      totalConf += r.confidence;
      pagesDone++;
    } catch (e) {
      logger.warn('page ocr failed', { error: (e as Error).message });
    }
  }
  const meanConf = pagesDone ? totalConf / pagesDone : 0;
  logger.info('pdf ocr combined', {
    pages: pagesDone,
    confidence: meanConf,
    textLength: combined.length,
  });
  return { text: combined, confidence: meanConf, pages: pagesDone };
}

/**
 * Terminates OCR worker.
 * @returns void
 */
export async function terminateOcr(): Promise<void> {
  await serializeWorker(async () => {
    if (tesseractWorker) {
      await tesseractWorker.terminate();
      tesseractWorker = null;
    }
  });
}
