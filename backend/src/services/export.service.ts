/**
 * services/export.service.ts — PDF and CSV export generation.
 */

import PDFDocument from "pdfkit";
import { getSummary } from "./summary.service.js";

/**
 * Generates summary PDF.
 * @param userId User id
 * @param category Optional category filter
 * @returns PDF buffer
 */
export async function generateSummaryPdf(
  userId: string,
  category?: string,
): Promise<Buffer> {
  const summary = await getSummary(
    userId,
    30,
    category ? { category } : undefined,
  );
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(20).text("ClarityDocs — 30-Day Summary", { align: "center" });
    doc.moveDown();
    doc
      .fontSize(10)
      .text(`Generated: ${new Date().toISOString().slice(0, 10)}`, {
        align: "center",
      });
    doc.moveDown();
    doc.fontSize(12).text(`Total Documents: ${summary.totalDocs}`);
    doc.text(`Sum Total: ${summary.sumTotal.toFixed(2)}`);
    doc.text(`Average Usage (avg total): ${summary.avgUsage.toFixed(2)}`);
    doc.text(
      `Authenticity (avg confidence): ${(summary.avgConfidence * 100).toFixed(1)}%`,
    );
    doc.moveDown();
    doc.fontSize(14).text("By Document Type");
    doc.moveDown(0.5);
    doc.fontSize(9);
    if (summary.byType.length === 0) doc.text("No data");
    else
      for (const r of summary.byType)
        doc.text(`${r.document_type}: count=${r.cnt}, sum=${r.sum.toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(14).text("Daily Trend (last 30 days)");
    doc.moveDown(0.5);
    doc.fontSize(9);
    if (summary.trend.length === 0) doc.text("No data");
    else
      for (const r of summary.trend)
        doc.text(`${r.date}: count=${r.cnt}, sum=${r.sum.toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(14).text("Top Vendors");
    doc.moveDown(0.5);
    doc.fontSize(9);
    if (summary.topVendors.length === 0) doc.text("No data");
    else
      for (const r of summary.topVendors)
        doc.text(`${r.vendor}: count=${r.cnt}, sum=${r.sum.toFixed(2)}`);
    doc.end();
  });
}

/**
 * Generates summary CSV.
 * @param userId User id
 * @param category Optional category filter
 * @returns CSV string
 */
export async function generateSummaryCsv(
  userId: string,
  category?: string,
): Promise<string> {
  const summary = await getSummary(
    userId,
    30,
    category ? { category } : undefined,
  );
  const lines: string[] = [];
  lines.push(`Total Documents,${summary.totalDocs}`);
  lines.push(`Sum Total,${summary.sumTotal.toFixed(2)}`);
  lines.push(`Average Usage,${summary.avgUsage.toFixed(2)}`);
  lines.push(`Authenticity,${(summary.avgConfidence * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("By Type,Count,Sum");
  for (const r of summary.byType)
    lines.push(`${r.document_type},${r.cnt},${r.sum.toFixed(2)}`);
  lines.push("");
  lines.push("Date,Count,Sum");
  for (const r of summary.trend)
    lines.push(`${r.date},${r.cnt},${r.sum.toFixed(2)}`);
  lines.push("");
  lines.push("Vendor,Count,Sum");
  for (const r of summary.topVendors)
    lines.push(
      `"${r.vendor.replace(/"/g, '""')}",${r.cnt},${r.sum.toFixed(2)}`,
    );
  return lines.join("\n");
}
