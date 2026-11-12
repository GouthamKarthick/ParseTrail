import assert from "assert";
import fs from "fs";
import path from "path";
import { extract } from "./extraction.service.js";
import { terminateOcr } from "./ocr.service.js";

const fixtures = path.resolve("fixtures");

function fixture(name: string): string {
  const filePath = path.join(fixtures, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing extraction fixture: ${filePath}`);
  }
  return filePath;
}

async function testTextPdf() {
  const r = await extract(fixture("text-invoice.pdf"));
  console.log("textPdf result:", r);
  assert.ok(
    r.data.totalAmount !== undefined,
    "textPdf should extract totalAmount",
  );
  assert.equal(r.data.currency, "USD");
  console.log("✓ textPdf");
}

async function testImagePng() {
  const r = await extract(fixture("invoice-image.png"));
  console.log("imagePng result:", r);
  // OCR may extract 1300
  assert.ok(
    r.data.totalAmount === 1300 || r.data.totalAmount === 1300.0,
    `imagePng totalAmount expected 1300 got ${r.data.totalAmount}`,
  );
  console.log("✓ imagePng tesseract+regex");
}

async function testReceiptPng() {
  const r = await extract(fixture("receipt-image.png"));
  console.log("receiptPng result:", r);
  assert.ok(
    r.data.totalAmount === 200,
    `receipt total 200 got ${r.data.totalAmount}`,
  );
  assert.equal(r.data.currency, "INR");
  console.log("✓ receiptPng");
}

async function testScannedPdf() {
  const r = await extract(fixture("scanned-invoice.pdf"));
  console.log("scannedPdf result:", r);
  assert.ok(
    r.data.totalAmount !== undefined,
    "scannedPdf should extract via lib OCR rasterize",
  );
  console.log("✓ scannedPdf rasterize+ocr");
}

async function testHindiMixed() {
  const r = await extract(fixture("invoice-hindi-mixed.png"));
  console.log("hindiMixed result:", r);
  assert.ok(
    r.data.totalAmount === 4520,
    `hindi total 4520 got ${r.data.totalAmount}`,
  );
  console.log("✓ hindiMixed");
}

(async () => {
  console.log(
    "Running Phase 1 extraction tests (lib-first, no AI key needed for clean scans)...",
  );
  try {
    await testTextPdf();
    await testImagePng();
    await testReceiptPng();
    await testScannedPdf();
    await testHindiMixed();
    console.log("All Phase 1 tests done");
  } finally {
    await terminateOcr();
  }
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
