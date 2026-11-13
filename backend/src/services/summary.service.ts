/**
 * services/summary.service.ts — Dashboard aggregation queries.
 */

import { pool } from "../db/pool.js";
import { config } from "../config.js";

export interface Summary {
  totalDocs: number;
  sumTotal: number;
  avgUsage: number;
  avgConfidence: number;
  byType: Array<{ document_type: string; cnt: number; sum: number }>;
  trend: Array<{ date: string; cnt: number; sum: number }>;
  topVendors: Array<{ vendor: string; cnt: number; sum: number }>;
}

interface SummaryRow {
  kind: "total" | "type" | "trend" | "vendor";
  group_key: string | null;
  cnt: number | string;
  sum_total: number | string;
  amount_count: number | string | null;
  avg_confidence: number | string | null;
}

/**
 * Fetches summary stats for a user.
 * @param userId User id
 * @param days Window in days
 * @param opts Optional category filter
 * @returns Summary object
 */
export async function getSummary(
  userId: string,
  days = 30,
  opts?: { category?: string },
): Promise<Summary> {
  const category = opts?.category;
  const catFilter =
    category && ["financial", "unknown"].includes(category)
      ? " AND document_category = ? "
      : "";
  const params: unknown[] = [userId, days];
  if (catFilter) params.push(category);
  params.push(config.currencyConversion.targetCurrency);

  const [rows] = await pool.query(
    `WITH extracted AS (
      SELECT
        document_type,
        DATE(created_at) AS doc_date,
        JSON_UNQUOTE(JSON_EXTRACT(data, '$.vendor')) AS vendor,
        JSON_EXTRACT(data, '$.invoiceNumber') IS NOT NULL AS has_invoice_number,
        JSON_EXTRACT(data, '$.invoiceDate') IS NOT NULL AS has_invoice_date,
        JSON_EXTRACT(data, '$.totalAmount') IS NOT NULL AS has_total_amount,
        JSON_UNQUOTE(JSON_EXTRACT(data, '$.currencyConverted')) AS currency_converted,
        JSON_UNQUOTE(JSON_EXTRACT(data, '$.currency')) AS currency,
        CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.totalAmountConverted')) AS DECIMAL(12,2)) AS total_converted,
        CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.totalAmount')) AS DECIMAL(12,2)) AS total_amount
      FROM documents
      WHERE user_id=? AND status='done' AND expires_at > NOW()
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${catFilter}
    ),
    filtered AS (
      SELECT
        document_type,
        doc_date,
        vendor,
        CASE
          WHEN COALESCE(currency_converted, currency) = ?
          THEN COALESCE(total_converted, total_amount)
          ELSE NULL
        END AS target_amount,
        ((vendor IS NOT NULL) + has_invoice_number + has_invoice_date + has_total_amount) / 4 AS confidence
      FROM extracted
    ),
    type_rows AS (
      SELECT document_type, COUNT(*) AS cnt, COALESCE(SUM(target_amount), 0) AS sum_total
      FROM filtered
      GROUP BY document_type
    ),
    trend_rows AS (
      SELECT DATE_FORMAT(doc_date, '%Y-%m-%d') AS doc_date, COUNT(*) AS cnt, COALESCE(SUM(target_amount), 0) AS sum_total
      FROM filtered
      GROUP BY doc_date
    ),
    vendor_rows AS (
      SELECT vendor, COUNT(*) AS cnt, COALESCE(SUM(target_amount), 0) AS sum_total
      FROM filtered
      WHERE vendor IS NOT NULL
      GROUP BY vendor
      ORDER BY cnt DESC
      LIMIT 5
    )
    SELECT
      'total' AS kind,
      NULL AS group_key,
      COUNT(*) AS cnt,
      COALESCE(SUM(target_amount), 0) AS sum_total,
      SUM(target_amount IS NOT NULL) AS amount_count,
      COALESCE(AVG(confidence), 0) AS avg_confidence
    FROM filtered
    UNION ALL
    SELECT 'type', document_type, cnt, sum_total, NULL, NULL FROM type_rows
    UNION ALL
    SELECT 'trend', doc_date, cnt, sum_total, NULL, NULL FROM trend_rows
    UNION ALL
    SELECT 'vendor', vendor, cnt, sum_total, NULL, NULL FROM vendor_rows`,
    params,
  );
  const summaryRows = rows as SummaryRow[];
  const total = summaryRows.find((row) => row.kind === "total");
  const totalDocs = Number(total?.cnt ?? 0);
  const sumTotal = Number(total?.sum_total ?? 0);
  const amountCount = Number(total?.amount_count ?? 0);

  return {
    totalDocs,
    sumTotal,
    avgUsage: amountCount ? sumTotal / amountCount : 0,
    avgConfidence: Number(total?.avg_confidence ?? 0),
    byType: summaryRows
      .filter((row) => row.kind === "type")
      .map((row) => ({
        document_type: String(row.group_key),
        cnt: Number(row.cnt),
        sum: Number(row.sum_total),
      })),
    trend: summaryRows
      .filter((row) => row.kind === "trend")
      .map((row) => ({
        date: String(row.group_key).slice(0, 10),
        cnt: Number(row.cnt),
        sum: Number(row.sum_total),
      })),
    topVendors: summaryRows
      .filter((row) => row.kind === "vendor")
      .sort((a, b) => Number(b.cnt) - Number(a.cnt))
      .map((row) => ({
        vendor: String(row.group_key),
        cnt: Number(row.cnt),
        sum: Number(row.sum_total),
      })),
  };
}
