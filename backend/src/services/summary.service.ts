/**
 * services/summary.service.ts — Dashboard aggregation queries.
 */

import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { parseJsonColumn } from "../utils/json.js";

export interface Summary {
  totalDocs: number;
  sumTotal: number;
  avgUsage: number;
  avgConfidence: number;
  byType: Array<{ document_type: string; cnt: number; sum: number }>;
  trend: Array<{ date: string; cnt: number; sum: number }>;
  topVendors: Array<{ vendor: string; cnt: number; sum: number }>;
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
  const catParam: unknown[] = catFilter ? [category] : [];
  const target = config.currencyConversion.targetCurrency;
  const amountExpr = `COALESCE(SUM(CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data,'$.currencyConverted')),JSON_UNQUOTE(JSON_EXTRACT(data,'$.currency'))) = '${target}' THEN CAST(COALESCE(JSON_EXTRACT(data,'$.totalAmountConverted'),JSON_EXTRACT(data,'$.totalAmount')) AS DECIMAL(12,2)) ELSE 0 END),0)`;
  const catForConf = category ? " AND document_category = ? " : "";
  const catConfParam: unknown[] = category ? [category] : [];
  const [[totalRows], [byType], [trend], [vendors], [confRows]] =
    await Promise.all([
      pool.query(
        `SELECT COUNT(*) as cnt, ${amountExpr} as sum FROM documents WHERE user_id=? AND status='done' AND expires_at > NOW() AND created_at >= NOW() - INTERVAL ? DAY ${catFilter}`,
        [userId, days, ...catParam],
      ),
      pool.query(
        `SELECT document_type, COUNT(*) as cnt, ${amountExpr} as sum FROM documents WHERE user_id=? AND status='done' AND expires_at > NOW() AND created_at >= NOW() - INTERVAL ? DAY ${catFilter} GROUP BY document_type`,
        [userId, days, ...catParam],
      ),
      pool.query(
        `SELECT DATE(created_at) as date, COUNT(*) as cnt, ${amountExpr} as sum FROM documents WHERE user_id=? AND status='done' AND expires_at > NOW() AND created_at >= NOW() - INTERVAL ? DAY ${catFilter} GROUP BY DATE(created_at) ORDER BY date`,
        [userId, days, ...catParam],
      ),
      pool.query(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.vendor')) as vendor, COUNT(*) as cnt, ${amountExpr} as sum FROM documents WHERE user_id=? AND status='done' AND expires_at > NOW() AND created_at >= NOW() - INTERVAL ? DAY ${catFilter} AND JSON_EXTRACT(data,'$.vendor') IS NOT NULL GROUP BY vendor ORDER BY cnt DESC LIMIT 5`,
        [userId, days, ...catParam],
      ),
      pool.query(
        `SELECT data FROM documents WHERE user_id=? AND status='done' AND expires_at > NOW() AND created_at >= NOW() - INTERVAL ? DAY ${catForConf}`,
        [userId, days, ...catConfParam],
      ),
    ]);
  const total = (totalRows as Array<{ cnt: number; sum: string }>)[0];

  let avgConfidence = 0;
  const datas = confRows as Array<{ data: string }>;
  if (datas.length) {
    let sum = 0;
    for (const r of datas) {
      const d = parseJsonColumn<Record<string, unknown> | null>(
        r.data as string,
        null,
      );
      if (!d) continue;
      const filled = [
        "vendor",
        "invoiceNumber",
        "invoiceDate",
        "totalAmount",
      ].filter((k) => d[k] != null).length;
      sum += filled / 4;
    }
    avgConfidence = sum / datas.length;
  }

  const totalDocs = Number(total?.cnt ?? 0);
  const sumTotal = Number(total?.sum ?? 0);
  return {
    totalDocs,
    sumTotal,
    avgUsage: totalDocs ? sumTotal / totalDocs : 0,
    avgConfidence,
    byType: (
      byType as Array<{ document_type: string; cnt: number; sum: string }>
    ).map((r) => ({
      document_type: r.document_type,
      cnt: Number(r.cnt),
      sum: Number(r.sum),
    })),
    trend: (trend as Array<{ date: string; cnt: number; sum: string }>).map(
      (r) => ({
        date: String(r.date).slice(0, 10),
        cnt: Number(r.cnt),
        sum: Number(r.sum),
      }),
    ),
    topVendors: (
      vendors as Array<{ vendor: string; cnt: number; sum: string }>
    ).map((r) => ({
      vendor: r.vendor,
      cnt: Number(r.cnt),
      sum: Number(r.sum),
    })),
  };
}
