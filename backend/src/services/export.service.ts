/**
 * services/export.service.ts — PDF and CSV export generation.
 */

import PDFDocument from 'pdfkit';
import { pool } from '../db/pool.js';
import { getSummary } from './summary.service.js';
import { parseJsonColumn } from '../utils/json.js';

/**
 * Filters supported by the per-document CSV export (mirrors listDocuments).
 */
export interface DocumentExportFilters {
  type?: string | string[];
  q?: string;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
}

const BOM = '\uFEFF';
const CRLF = '\r\n';

/**
 * Escapes a single CSV cell. Text values starting with =, +, - or @ get a
 * leading single quote to neutralise CSV formula injection. Real numeric
 * columns are never prefixed. Fields containing a comma, quote or newline are
 * wrapped in double quotes with inner quotes doubled.
 * @param value Cell value
 * @param isNumeric True for real numeric columns (no formula prefix)
 * @returns Escaped cell text
 */
function docCell(value: string | number | null | undefined, isNumeric: boolean): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (!isNumeric && /^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[,"\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  return String(value ?? '');
}

/**
 * Generates a per-document CSV export: one row per document owned by the
 * user, filtered by the same query filters as the document list.
 * @param userId Id of the requesting user (ownership is enforced)
 * @param filters Optional list-style filters
 * @returns CSV string with UTF-8 BOM and CRLF line endings
 */
export async function generateDocumentsCsv(
  userId: string,
  filters: DocumentExportFilters
): Promise<string> {
  const where: string[] = ['user_id = ?', 'expires_at > NOW()'];
  const params: unknown[] = [userId];

  const types = Array.isArray(filters.type) ? filters.type : filters.type ? [filters.type] : [];
  if (types.length) {
    where.push(`document_type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  if (filters.q) {
    where.push('name LIKE ?');
    const escaped = String(filters.q).replace(/[%_\\]/g, '\\$&');
    params.push(`%${escaped}%`);
  }
  if (filters.category && ['financial', 'unknown'].includes(filters.category)) {
    where.push('document_category = ?');
    params.push(filters.category);
  }
  if (filters.dateFrom) {
    where.push('created_at >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push('created_at <= ?');
    params.push(`${filters.dateTo} 23:59:59`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT id, created_at, status, document_type, document_category, data FROM documents ${whereSql} ORDER BY created_at DESC LIMIT 5000`,
    params
  );
  const docs = rows as Array<Record<string, unknown>>;
  const ids = docs.map(d => d.id);

  // Latest extraction-attempt confidence per document.
  const confidenceByDoc: Record<string, string> = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const [attempts] = await pool.query(
      `SELECT document_id, confidence FROM extraction_attempts WHERE document_id IN (${placeholders}) ORDER BY created_at DESC, id DESC`,
      ids
    );
    const seen = new Set<string>();
    for (const a of attempts as Array<{ document_id: string; confidence: number }>) {
      if (seen.has(a.document_id)) continue;
      seen.add(a.document_id);
      confidenceByDoc[a.document_id] = Number.isFinite(a.confidence) ? String(a.confidence) : '';
    }
  }

  // Latest refine status per document.
  const refineByDoc: Record<string, string> = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const [rrows] = await pool.query(
      `SELECT r.document_id, r.status FROM refine_jobs r INNER JOIN (SELECT document_id, MAX(created_at) AS mc FROM refine_jobs WHERE document_id IN (${placeholders}) GROUP BY document_id) latest ON latest.document_id = r.document_id AND latest.mc = r.created_at`,
      ids
    );
    for (const r of rrows as Array<{ document_id: string; status: string }>) {
      refineByDoc[r.document_id] = r.status;
    }
  }

  // Documents owned by this user that have at least one correction row.
  const correctedDocs = new Set<string>();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const [crows] = await pool.query(
      `SELECT DISTINCT document_id FROM corrections WHERE user_id=? AND document_id IN (${placeholders})`,
      [userId, ...ids]
    );
    for (const c of crows as Array<{ document_id: string }>) {
      correctedDocs.add(c.document_id);
    }
  }

  const parsed = docs.map(d => ({
    doc: d,
    data: (parseJsonColumn<Record<string, unknown> | null>(d.data as string | null, null) ??
      {}) as Record<string, unknown>,
  }));

  // The totalAmountINR column only exists when at least one document has it.
  const hasInr = parsed.some(p => Object.prototype.hasOwnProperty.call(p.data, 'totalAmountINR'));

  const header = [
    'id',
    'created_at',
    'document_type',
    'document_category',
    'status',
    'confidence',
    'vendor',
    'invoiceNumber',
    'date',
    'currency',
    'totalAmount',
    ...(hasInr ? ['totalAmountINR'] : []),
    'corrected',
    'refine_status',
  ];

  const lines: string[] = [header.join(',')];
  for (const { doc, data } of parsed) {
    const id = String(doc.id ?? '');
    const row: string[] = [
      docCell(id, true),
      docCell(formatDate(doc.created_at), true),
      docCell(String(doc.document_type ?? ''), true),
      docCell(String(doc.document_category ?? ''), true),
      docCell(String(doc.status ?? ''), true),
      docCell(confidenceByDoc[id] ?? '', true),
      docCell(String(data.vendor ?? ''), false),
      docCell(String(data.invoiceNumber ?? ''), false),
      docCell(String(data.invoiceDate ?? ''), false),
      docCell(String(data.currency ?? ''), false),
      docCell(String(data.totalAmount ?? ''), true),
    ];
    if (hasInr) row.push(docCell(String(data.totalAmountINR ?? ''), true));
    row.push(docCell(correctedDocs.has(id) ? 'yes' : 'no', true));
    row.push(docCell(refineByDoc[id] ?? '', true));
    lines.push(row.join(','));
  }

  return BOM + lines.join(CRLF) + CRLF;
}

/**
 * Generates summary PDF.
 * @param userId User id
 * @param category Optional category filter
 * @returns PDF buffer
 */
export async function generateSummaryPdf(userId: string, category?: string): Promise<Buffer> {
  const summary = await getSummary(userId, 30, category ? { category } : undefined);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(20).text('ParseTrail — 30-Day Summary', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated: ${new Date().toISOString().slice(0, 10)}`, {
      align: 'center',
    });
    doc.moveDown();
    doc.fontSize(12).text(`Total Documents: ${summary.totalDocs}`);
    doc.text(`Sum Total: ${summary.sumTotal.toFixed(2)}`);
    doc.text(`Average Total: ${summary.avgUsage.toFixed(2)}`);
    doc.text(`Average Confidence: ${(summary.avgConfidence * 100).toFixed(1)}%`);
    doc.moveDown();
    doc.fontSize(14).text('By Document Type');
    doc.moveDown(0.5);
    doc.fontSize(9);
    if (summary.byType.length === 0) doc.text('No data');
    else
      for (const r of summary.byType)
        doc.text(`${r.document_type}: count=${r.cnt}, sum=${r.sum.toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(14).text('Daily Trend (last 30 days)');
    doc.moveDown(0.5);
    doc.fontSize(9);
    if (summary.trend.length === 0) doc.text('No data');
    else
      for (const r of summary.trend) doc.text(`${r.date}: count=${r.cnt}, sum=${r.sum.toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(14).text('Top Vendors');
    doc.moveDown(0.5);
    doc.fontSize(9);
    if (summary.topVendors.length === 0) doc.text('No data');
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
export async function generateSummaryCsv(userId: string, category?: string): Promise<string> {
  const summary = await getSummary(userId, 30, category ? { category } : undefined);
  const lines: string[] = [];
  lines.push(csvRow('Total Documents', summary.totalDocs));
  lines.push(csvRow('Sum Total', summary.sumTotal.toFixed(2)));
  lines.push(csvRow('Average Total', summary.avgUsage.toFixed(2)));
  lines.push(csvRow('Average Confidence', `${(summary.avgConfidence * 100).toFixed(1)}%`));
  lines.push('');
  lines.push('By Type,Count,Sum');
  for (const r of summary.byType) lines.push(csvRow(r.document_type, r.cnt, r.sum.toFixed(2)));
  lines.push('');
  lines.push('Date,Count,Sum');
  for (const r of summary.trend) lines.push(csvRow(r.date, r.cnt, r.sum.toFixed(2)));
  lines.push('');
  lines.push('Vendor,Count,Sum');
  for (const r of summary.topVendors) lines.push(csvRow(r.vendor, r.cnt, r.sum.toFixed(2)));
  return lines.join('\n');
}

function csvRow(...values: Array<string | number>): string {
  return values.map(csvCell).join(',');
}

function csvCell(value: string | number): string {
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
