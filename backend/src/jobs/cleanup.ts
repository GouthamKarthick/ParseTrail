/**
 * jobs/cleanup.ts — Scheduled purge of expired documents and files.
 */

import fs from "fs/promises";
import { pool } from "../db/pool.js";
import { logger } from "../config/logger.js";

/**
 * Deletes expired documents and their files.
 * @returns Number of purged documents
 */
export async function purgeExpired(): Promise<number> {
  const [rows] = await pool.query(
    "SELECT id, path FROM documents WHERE expires_at < NOW() LIMIT 500",
  );
  const docs = rows as Array<{ id: string; path: string }>;
  if (docs.length === 0) return 0;
  for (const d of docs) {
    try {
      await fs.unlink(d.path);
    } catch {}
  }
  const ids = docs.map((d) => d.id);
  await pool.query(
    `DELETE FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  logger.info("Purge expired", { count: docs.length });
  return docs.length;
}
