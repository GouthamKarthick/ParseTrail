/**
 * services/summary.service.ts — Dashboard aggregation queries.
 */

import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { needsReview } from '../utils/review.js';
import { parseJsonColumn } from '../utils/json.js';

export interface Summary {
  totalDocs: number;
  sumTotal: number;
  avgUsage: number;
  avgConfidence: number;
  byType: Array<{ document_type: string; cnt: number; sum: number }>;
  trend: Array<{ date: string; cnt: number; sum: number }>;
  topVendors: Array<{ vendor: string; cnt: number; sum: number }>;
}

/** Pipeline efficiency metrics surfaced on the dashboard (zero new tables). */
export interface ExtractionMetrics {
  /** % of completed docs handled by rules/Flan with zero cloud token spend */
  localOnlyPercent: number;
  /** Number of cloud LLM attempts in the window */
  cloudCalls: number;
  /** Sum of input + output tokens spent in the window */
  totalTokens: number;
  /** Completed docs not yet approved (awaiting review) */
  needsReviewCount: number;
}

interface SummaryRow {
  kind: 'total' | 'type' | 'trend' | 'vendor';
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
  opts?: { category?: string }
): Promise<Summary> {
  const category = opts?.category;
  const catFilter =
    category && ['financial', 'unknown'].includes(category) ? ' AND document_category = ? ' : '';
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
    params
  );
  const summaryRows = rows as SummaryRow[];
  const total = summaryRows.find(row => row.kind === 'total');
  const totalDocs = Number(total?.cnt ?? 0);
  const sumTotal = Number(total?.sum_total ?? 0);
  const amountCount = Number(total?.amount_count ?? 0);

  return {
    totalDocs,
    sumTotal,
    avgUsage: amountCount ? sumTotal / amountCount : 0,
    avgConfidence: Number(total?.avg_confidence ?? 0),
    byType: summaryRows
      .filter(row => row.kind === 'type')
      .map(row => ({
        document_type: String(row.group_key),
        cnt: Number(row.cnt),
        sum: Number(row.sum_total),
      })),
    trend: summaryRows
      .filter(row => row.kind === 'trend')
      .map(row => ({
        date: String(row.group_key).slice(0, 10),
        cnt: Number(row.cnt),
        sum: Number(row.sum_total),
      })),
    topVendors: summaryRows
      .filter(row => row.kind === 'vendor')
      .sort((a, b) => Number(b.cnt) - Number(a.cnt))
      .map(row => ({
        vendor: String(row.group_key),
        cnt: Number(row.cnt),
        sum: Number(row.sum_total),
      })),
  };
}

/**
 * Extraction pipeline efficiency metrics for the dashboard.
 * Scoped to one user and a trailing window (default 30 days).
 * @param userId Owner id
 * @param days Trailing window in days
 * @returns ExtractionMetrics
 */
export async function getExtractionMetrics(userId: string, days = 30): Promise<ExtractionMetrics> {
  const [totalRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM documents
     WHERE user_id=? AND status='done' AND expires_at > NOW()
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, days]
  );
  const totalDocs = Number((totalRows as Array<{ cnt: number }>)[0]?.cnt ?? 0);

  const [cloudRows] = await pool.query(
    `SELECT COUNT(*) AS cloudCalls,
            COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS totalTokens,
            COUNT(DISTINCT document_id) AS docsWithCloud
     FROM extraction_attempts ea
     JOIN documents d ON d.id = ea.document_id
     WHERE d.user_id=? AND d.status='done' AND d.expires_at > NOW()
       AND ea.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND ea.method = 'llm'`,
    [userId, days]
  );
  const cloud = (
    cloudRows as Array<{
      cloudCalls: number;
      totalTokens: number | string;
      docsWithCloud: number;
    }>
  )[0];
  const cloudCalls = Number(cloud?.cloudCalls ?? 0);
  const totalTokens = Number(cloud?.totalTokens ?? 0);
  const docsWithCloud = Number(cloud?.docsWithCloud ?? 0);

  // needs_review mirrors utils/review.ts (confidence < 0.8, missing
  // vendor/date/total, dead refine job, or a POSSIBLE_DUPLICATE/FUTURE_DATE
  // alert). These conditions can't all be expressed in SQL, so load the
  // user's done, non-expired documents (capped at 1000) and count in code.
  const [nrRows] = await pool.query(
    `SELECT d.data, d.reviewed_at,
            (SELECT r.status FROM refine_jobs r WHERE r.document_id = d.id ORDER BY r.created_at DESC LIMIT 1) AS refine_status,
            (SELECT ea.confidence FROM extraction_attempts ea WHERE ea.document_id = d.id ORDER BY ea.seq DESC LIMIT 1) AS confidence
     FROM documents d
     WHERE d.user_id=? AND d.status='done' AND d.expires_at > NOW()
     ORDER BY d.created_at DESC
     LIMIT 1000`,
    [userId]
  );
  const docs = nrRows as Array<{
    data: string | null;
    reviewed_at: string | null;
    refine_status: string | null;
    confidence: number | null;
  }>;
  let needsReviewCount = 0;
  for (const doc of docs) {
    const data = parseJsonColumn<Record<string, unknown> | null>(doc.data, null);
    if (
      needsReview({
        reviewed_at: doc.reviewed_at,
        confidence: doc.confidence,
        data,
        refine_status: doc.refine_status,
      })
    ) {
      needsReviewCount++;
    }
  }

  const localOnlyPercent =
    totalDocs > 0 ? Math.round(((totalDocs - docsWithCloud) / totalDocs) * 100) : 0;

  return { localOnlyPercent, cloudCalls, totalTokens, needsReviewCount };
}
