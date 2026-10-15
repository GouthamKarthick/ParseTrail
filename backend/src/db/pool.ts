/**
 * db/pool.ts — MySQL connection pool with TLS handling.
 */

import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import { config } from "../config.js";

/**
 * Resolves SSL config from env cert or filesystem.
 * @returns SSL options or undefined
 */
function getSslConfig():
  | { ca: string; rejectUnauthorized: boolean }
  | { rejectUnauthorized: boolean }
  | undefined {
  if (!config.db.ssl) return undefined;
  if (config.db.sslCa) {
    const ca = config.db.sslCa.replace(/\\n/g, "\n");
    if (ca.includes("BEGIN CERTIFICATE"))
      return { ca, rejectUnauthorized: true };
  }
  const candidates = [
    config.db.sslCaPath,
    "./ca.pem",
    "backend/ca.pem",
    path.join(process.cwd(), "ca.pem"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const ca = fs.readFileSync(p, "utf-8");
        if (ca.includes("BEGIN CERTIFICATE"))
          return { ca, rejectUnauthorized: true };
      }
    } catch {}
  }
  return { rejectUnauthorized: true };
}

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  ...(getSslConfig() ? { ssl: getSslConfig() } : {}),
});
