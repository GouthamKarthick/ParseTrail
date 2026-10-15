import assert from "assert";
import fs from "fs";
import path from "path";
import { extract } from "./extraction.service.js";

const fixtures = path.resolve("fixtures");

async function testTextPdf() {
  const p = path.join(fixtures, "text-invoice.pdf");
  if (!fs.existsSync(p)) {
    console.log("SKIP text-invoice.pdf missing");
    return;
  }
  const r = await extract(p);
  console.log("textPdf result:", r);
  assert.ok(
    r.data.totalAmount !== undefined,
    "textPdf should extract totalAmount",
  );
  assert.equal(r.data.currency, "USD");
  console.log("✓ textPdf");
}

async function testImagePng() {
  const p = path.join(fixtures, "invoice-image.png");
  const r = await extract(p);
  console.log("imagePng result:", r);
  // OCR may extract 1300
  assert.ok(
    r.data.totalAmount === 1300 || r.data.totalAmount === 1300.0,
    `imagePng totalAmount expected 1300 got ${r.data.totalAmount}`,
  );
  console.log("✓ imagePng tesseract+regex");
}

async function testReceiptPng() {
  const p = path.join(fixtures, "receipt-image.png");
  const r = await extract(p);
  console.log("receiptPng result:", r);
  assert.ok(
    r.data.totalAmount === 200,
    `receipt total 200 got ${r.data.totalAmount}`,
  );
  assert.equal(r.data.currency, "INR");
  console.log("✓ receiptPng");
}

async function testScannedPdf() {
  const p = path.join(fixtures, "scanned-invoice.pdf");
  const r = await extract(p);
  console.log("scannedPdf result:", r);
  assert.ok(
    r.data.totalAmount !== undefined,
    "scannedPdf should extract via lib OCR rasterize",
  );
  console.log("✓ scannedPdf rasterize+ocr");
}

async function testHindiMixed() {
  const p = path.join(fixtures, "invoice-hindi-mixed.png");
  const r = await extract(p);
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
  await testTextPdf();
  await testImagePng();
  await testReceiptPng();
  await testScannedPdf();
  await testHindiMixed();
  console.log("All Phase 1 tests done");
})();
