/**
 * db/pool.ts — MySQL connection pool with TLS handling.
 */

import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import type { PoolConnection } from 'mysql2/promise';
import { config } from '../config.js';

/**
 * Resolves SSL config from env cert or filesystem.
 * @returns SSL options or undefined
 */
function getSslConfig():
  { ca: string; rejectUnauthorized: boolean } | { rejectUnauthorized: boolean } | undefined {
  if (!config.db.ssl) return undefined;
  if (config.db.sslCa) {
    const ca = config.db.sslCa.replace(/\\n/g, '\n');
    if (ca.includes('BEGIN CERTIFICATE')) return { ca, rejectUnauthorized: true };
  }
  const candidates = [
    config.db.sslCaPath,
    './ca.pem',
    'backend/ca.pem',
    path.join(process.cwd(), 'ca.pem'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const ca = fs.readFileSync(p, 'utf-8');
        if (ca.includes('BEGIN CERTIFICATE')) return { ca, rejectUnauthorized: true };
      }
    } catch {}
  }
  return { rejectUnauthorized: true };
}

const ssl = getSslConfig();

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 5,
  idleTimeout: 60_000,
  queueLimit: 100,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  dateStrings: true,
  ...(ssl ? { ssl } : {}),
});

/**
 * Runs a function inside a single MySQL transaction.
 *
 * Acquires a connection from the pool, begins a transaction, calls `fn(conn)`,
 * commits on success, rolls back on error (rethrowing the original error), and
 * always releases the connection back to the pool.
 *
 * mysql2 has no `pool.begin()`, so this wraps `getConnection()` /
 * `beginTransaction()` / `commit()` / `rollback()` / `release()`.
 *
 * @param fn - Callback receiving the transactional connection
 * @returns Whatever `fn` returns
 * @throws Re-throws whatever `fn` throws (after rollback)
 */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
