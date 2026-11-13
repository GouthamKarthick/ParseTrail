/**
 * jobs/cleanup.ts — Scheduled purge of expired documents and files.
 */

import fs from "fs/promises";
import type { Dirent } from "node:fs";
import path from "path";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { logger } from "../config/logger.js";

const PURGE_BATCH_SIZE = 500;

/**
 * Deletes all expired documents and old unverified accounts.
 * @returns Number of purged documents
 */
export async function purgeExpired(): Promise<number> {
  let total = 0;
  while (true) {
    const [rows] = await pool.query(
      "SELECT id, path FROM documents WHERE expires_at < NOW() ORDER BY expires_at, id LIMIT ?",
      [PURGE_BATCH_SIZE],
    );
    const docs = rows as Array<{ id: string; path: string }>;
    if (docs.length === 0) break;

    for (const doc of docs) {
      try {
        await fs.unlink(doc.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn("Expired document file could not be removed", {
            documentId: doc.id,
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }
    }

    await pool.query(
      `DELETE FROM documents WHERE id IN (${docs.map(() => "?").join(",")})`,
      docs.map((doc) => doc.id),
    );
    total += docs.length;
  }

  await pool.query(
    "DELETE FROM password_reset_tokens WHERE used=TRUE OR expires_at < NOW()",
  );
  await pool.query(
    "DELETE FROM users WHERE email_verified=FALSE AND created_at < NOW() - INTERVAL 7 DAY",
  );
  const orphanFiles = await removeOrphanFiles();
  if (total || orphanFiles)
    logger.info("Retention cleanup complete", { documents: total, orphanFiles });
  return total;
}

async function removeOrphanFiles(): Promise<number> {
  const [rows] = await pool.query("SELECT path FROM documents");
  const referenced = new Set(
    (rows as Array<{ path: string }>).map((row) =>
      path.resolve(row.path),
    ),
  );
  const uploadDir = path.resolve(config.uploadDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(uploadDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.resolve(uploadDir, entry.name);
    if (referenced.has(filePath)) continue;
    try {
      await fs.unlink(filePath);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("Orphan upload file could not be removed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }
  return removed;
}
