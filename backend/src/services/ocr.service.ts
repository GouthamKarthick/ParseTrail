/**
 * services/ocr.service.ts — OCR via Tesseract and PDF rasterization.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { logger } from "../config/logger.js";

const execFileAsync = promisify(execFile);

export interface OcrResult {
  text: string;
  confidence: number;
  pages: number;
}

let tesseractWorker: Awaited<
  ReturnType<(typeof import("tesseract.js"))["createWorker"]>
> | null = null;

/**
 * Gets or creates Tesseract worker.
 * @param lang Language
 * @returns Worker
 */
async function getWorker(lang: string) {
  if (tesseractWorker) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const curLangs: string = (tesseractWorker as any)._langs ?? "";
      if (curLangs.includes(lang)) return tesseractWorker;
      await tesseractWorker.terminate();
    } catch {}
    tesseractWorker = null;
  }
  const { createWorker } = await import("tesseract.js");
  const langs = lang === "eng" ? "eng" : `eng+${lang}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker: any = await createWorker(langs, 1, {});
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
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default ?? sharpMod;
    const meta = await sharp(input).metadata();
    let s = sharp(input);
    if (meta.width && meta.width < 1200)
      s = s.resize({
        width: 1800,
        withoutEnlargement: false,
        kernel: "lanczos3",
      });
    s = s.grayscale().normalize().sharpen({ sigma: 1.2 }).linear(1.1, -10);
    return await s.png().toBuffer();
  } catch (e) {
    logger.warn("sharp preprocess failed, using raw", {
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
async function ocrImageBuffer(
  imageBuffer: Buffer,
  hintLang: string,
): Promise<OcrResult> {
  const lang = hintLang || "eng";
  const preprocessed = await preprocessWithSharp(imageBuffer);
  const worker = await getWorker(lang);
  const { data } = await worker.recognize(preprocessed, {}, {
    text: true,
  } as never);
  const text = (data.text as string) || "";
  const confidence = typeof data.confidence === "number" ? data.confidence : 0;
  logger.debug("tesseract ocrImage", {
    lang,
    confidence,
    pages: 1,
    textSnippet: text.slice(0, 400),
  });
  return { text, confidence, pages: 1 };
}

/**
 * Rasterizes PDF to PNG buffers.
 * @param pdfBuffer PDF buffer
 * @returns PNG buffers
 */
async function rasterizePdfToPngs(pdfBuffer: Buffer): Promise<Buffer[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-raster-"));
  const tmpPdf = path.join(tmpDir, "input.pdf");
  const tmpPrefix = path.join(tmpDir, "page");
  try {
    await fs.writeFile(tmpPdf, pdfBuffer);
    try {
      await execFileAsync("pdftoppm", ["-png", "-r", "300", tmpPdf, tmpPrefix]);
      const files = await fs.readdir(tmpDir);
      const pngs = files
        .filter((f) => f.startsWith("page") && f.endsWith(".png"))
        .sort();
      const buffers: Buffer[] = [];
      for (const f of pngs)
        buffers.push(await fs.readFile(path.join(tmpDir, f)));
      if (buffers.length > 0) {
        logger.debug("pdftoppm rasterized", { pages: buffers.length });
        return buffers;
      }
    } catch (e) {
      logger.warn("pdftoppm failed, falling back to pdfjs-dist", {
        error: (e as Error).message,
      });
    }
    try {
      const pngs = await rasterizeWithPdfJs(pdfBuffer);
      if (pngs.length) return pngs;
    } catch (e) {
      logger.warn("pdfjs rasterize failed", { error: (e as Error).message });
    }
    return [];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fallback rasterization via pdfjs-dist.
 * @param pdfBuffer PDF buffer
 * @returns PNG buffers
 */
async function rasterizeWithPdfJs(pdfBuffer: Buffer): Promise<Buffer[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-ignore - optional peer deps
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // @ts-ignore - optional
    const { createCanvas } = await import("canvas");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) });
    const pdf = await loadingTask.promise;
    const out: Buffer[] = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 5); i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx as never, viewport }).promise;
      out.push(canvas.toBuffer("image/png"));
    }
    return out;
  } catch {
    return [];
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
  hintLang?: string,
): Promise<OcrResult> {
  const isPdf =
    mime === "application/pdf" || buffer.subarray(0, 4).toString() === "%PDF";
  if (!isPdf) {
    const actualLang = hintLang ?? "eng";
    return ocrImageBuffer(buffer, actualLang);
  }
  const pngs = await rasterizePdfToPngs(buffer);
  if (pngs.length === 0) {
    logger.warn(
      "rasterize returned 0 pages, trying direct tesseract on PDF buffer",
    );
    try {
      return await ocrImageBuffer(buffer, hintLang ?? "eng");
    } catch (e) {
      logger.warn("direct pdf tesseract failed", {
        error: (e as Error).message,
      });
      return { text: "", confidence: 0, pages: 0 };
    }
  }
  let combined = "";
  let totalConf = 0;
  let pagesDone = 0;
  const toOcr = pngs.slice(0, 3);
  const langHint = hintLang ?? "eng";
  for (const png of toOcr) {
    try {
      const r = await ocrImageBuffer(png, langHint);
      combined += (combined ? "\n\n" : "") + r.text;
      totalConf += r.confidence;
      pagesDone++;
    } catch (e) {
      logger.warn("page ocr failed", { error: (e as Error).message });
    }
  }
  const meanConf = pagesDone ? totalConf / pagesDone : 0;
  logger.info("pdf ocr combined", {
    pages: pagesDone,
    confidence: meanConf,
    textSnippet: combined.slice(0, 600),
  });
  return { text: combined, confidence: meanConf, pages: pagesDone };
}

/**
 * Terminates OCR worker.
 * @returns void
 */
export async function terminateOcr(): Promise<void> {
  if (tesseractWorker) {
    try {
      await tesseractWorker.terminate();
    } catch {}
    tesseractWorker = null;
  }
}
