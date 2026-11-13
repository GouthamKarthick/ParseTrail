/**
 * db/schema.ts — Database schema creation and migrations.
 */

import { pool } from "./pool.js";
import { config } from "../config.js";

const RETENTION_DAYS = Math.floor(config.retentionDays);

async function runDdl(sql: string): Promise<void> {
  try {
    await pool.query(sql);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      code === "ER_DUP_FIELDNAME" ||
      code === "ER_DUP_KEYNAME" ||
      code === "ER_FK_DUP_NAME"
    )
      return;
    throw error;
  }
}

/**
 * Ensures all tables, columns, and indexes exist.
 * @returns void
 */
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      first_name VARCHAR(50) NOT NULL,
      last_name VARCHAR(50) NOT NULL,
      phone VARCHAR(20) NULL,
      password_hash VARCHAR(255) NOT NULL,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      verification_token VARCHAR(255) NULL,
      verification_code VARCHAR(10) NULL,
      verification_expires DATETIME NULL,
      verification_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_avatars (
      user_id CHAR(36) PRIMARY KEY,
      mime VARCHAR(30) NOT NULL,
      data MEDIUMTEXT NOT NULL,
      size_bytes INT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user_expires (user_id, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id CHAR(36) PRIMARY KEY COMMENT 'UUID v4 server-generated, PK prevents dup',
      name VARCHAR(255) NOT NULL,
      path VARCHAR(500) NOT NULL,
      status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
      document_type VARCHAR(50) NOT NULL DEFAULT 'unknown' COMMENT 'invoice|receipt|payment|bill|payslip|settlement_slip|other|unknown',
      document_category VARCHAR(20) NOT NULL DEFAULT 'unknown' COMMENT 'financial|unknown',
      data JSON NULL,
      extracted_text MEDIUMTEXT NULL,
      error TEXT NULL,
      user_id CHAR(36) NULL COMMENT 'FK→users.id',
      expires_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL ${RETENTION_DAYS} DAY) COMMENT 'retention window',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status_created (status, created_at),
      INDEX idx_type_status (document_type, status),
      INDEX idx_category (document_category),
      INDEX idx_user_created (user_id, created_at),
      INDEX idx_expires (expires_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS extraction_attempts (
      id CHAR(36) PRIMARY KEY,
      seq INT NOT NULL AUTO_INCREMENT COMMENT 'insertion order for timeline',
      document_id CHAR(36) NOT NULL COMMENT 'FK→documents.id',
      method VARCHAR(50) NOT NULL COMMENT 'heuristic-detect|rule-based|local-llm|llm|fallback-merge',
      predicted_type VARCHAR(50) NULL COMMENT 'what this stage voted',
      confidence FLOAT NOT NULL DEFAULT 0,
      latency_ms INT NOT NULL DEFAULT 0,
      cost_estimate DECIMAL(10,4) NOT NULL DEFAULT 0 COMMENT 'USD, 0 for local/free-tier',
      input_tokens INT NULL,
      output_tokens INT NULL,
      succeeded BOOLEAN NOT NULL DEFAULT FALSE,
      fallback_reason VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_attempt_doc (document_id),
      UNIQUE KEY uq_attempt_seq (seq),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refine_jobs (
      id CHAR(36) PRIMARY KEY,
      document_id CHAR(36) NOT NULL COMMENT 'FK→documents.id',
      user_id CHAR(36) NULL COMMENT 'denormalized for fair scheduling',
      status ENUM('queued','working','done','dead') NOT NULL DEFAULT 'queued',
      attempts INT NOT NULL DEFAULT 0,
      next_retry_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_refine_due (status, next_retry_at),
      INDEX idx_refine_doc (document_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refine_quota (
      day DATE PRIMARY KEY,
      used INT NOT NULL DEFAULT 0 COMMENT 'free-tier guard'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS corrections (
      id CHAR(36) PRIMARY KEY,
      document_id CHAR(36) NOT NULL COMMENT 'FK→documents.id',
      user_id CHAR(36) NULL,
      field VARCHAR(50) NOT NULL,
      original_value TEXT NULL,
      corrected_value TEXT NULL,
      extraction_method VARCHAR(50) NULL COMMENT 'method that produced the original',
      confidence FLOAT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_corr_doc (document_id),
      INDEX idx_corr_user (user_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  const [migrationRows] = await pool.query(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(
    (migrationRows as Array<{ version: number }>).map((row) =>
      Number(row.version),
    ),
  );
  if (!applied.has(1)) {
    await migrateDocuments();
    await migrateUsers();
    await migrateAttempts();
    await pool.query(
      "INSERT IGNORE INTO schema_migrations (version, name) VALUES (1, 'initial-schema-migrations')",
    );
  }
  if (!applied.has(2)) {
    await migrateExtractedText();
    await pool.query(
      "INSERT IGNORE INTO schema_migrations (version, name) VALUES (2, 'cache-extracted-text')",
    );
  }
  if (!applied.has(3)) {
    await migrateRedundantIndexes();
    await pool.query(
      "INSERT IGNORE INTO schema_migrations (version, name) VALUES (3, 'remove-redundant-indexes')",
    );
  }
}

/**
 * Migrates documents table columns and indexes.
 * @returns void
 */
async function migrateDocuments(): Promise<void> {
  const colChecks: Array<[string, string]> = [
    [
      "document_type",
      "ALTER TABLE documents ADD COLUMN document_type VARCHAR(50) NOT NULL DEFAULT 'unknown' COMMENT 'invoice|receipt|payment|bill|payslip|settlement_slip|other|unknown' AFTER status",
    ],
    [
      "user_id",
      "ALTER TABLE documents ADD COLUMN user_id CHAR(36) NULL AFTER data",
    ],
    [
      "expires_at",
      `ALTER TABLE documents ADD COLUMN expires_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL ${RETENTION_DAYS} DAY) AFTER user_id`,
    ],
    [
      "document_category",
      "ALTER TABLE documents ADD COLUMN document_category VARCHAR(20) NOT NULL DEFAULT 'unknown' COMMENT 'financial|unknown' AFTER document_type",
    ],
    [
      "extracted_text",
      "ALTER TABLE documents ADD COLUMN extracted_text MEDIUMTEXT NULL AFTER data",
    ],
  ];
  for (const [col, sql] of colChecks) {
    const [cols] = await pool.query(
      "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='documents' AND COLUMN_NAME=?",
      [col],
    );
    if ((cols as Array<{ cnt: number }>)[0]?.cnt === 0) await runDdl(sql);
  }
  await pool.query(
    "ALTER TABLE documents MODIFY COLUMN document_category VARCHAR(20) NOT NULL DEFAULT 'unknown' COMMENT 'financial|unknown'",
  );
  await pool.query(
    `ALTER TABLE documents MODIFY COLUMN expires_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL ${RETENTION_DAYS} DAY)`,
  );

  const idxChecks: Array<[string, string]> = [
    [
      "idx_type_status",
      "ALTER TABLE documents ADD INDEX idx_type_status (document_type, status)",
    ],
    [
      "idx_user_created",
      "ALTER TABLE documents ADD INDEX idx_user_created (user_id, created_at)",
    ],
    ["idx_expires", "ALTER TABLE documents ADD INDEX idx_expires (expires_at)"],
    [
      "idx_category",
      "ALTER TABLE documents ADD INDEX idx_category (document_category)",
    ],
    [
      "idx_user_expires_type",
      "ALTER TABLE documents ADD INDEX idx_user_expires_type (user_id, expires_at, document_type)",
    ],
    [
      "idx_user_type_status",
      "ALTER TABLE documents ADD INDEX idx_user_type_status (user_id, document_type, status)",
    ],
    [
      "idx_user_status",
      "ALTER TABLE documents ADD INDEX idx_user_status (user_id, status)",
    ],
  ];
  for (const [idx, sql] of idxChecks) {
    const [rows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='documents' AND INDEX_NAME=?",
      [idx],
    );
    if ((rows as Array<{ cnt: number }>)[0]?.cnt === 0) await runDdl(sql);
  }

  const [oldTypeIndex] = await pool.query(
    "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='documents' AND INDEX_NAME='idx_document_type'",
  );
  if ((oldTypeIndex as Array<{ cnt: number }>)[0]?.cnt > 0)
    await pool.query("ALTER TABLE documents DROP INDEX idx_document_type");

  const [foreignKey] = await pool.query(
    "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='documents' AND COLUMN_NAME='user_id' AND REFERENCED_TABLE_NAME='users' AND REFERENCED_COLUMN_NAME='id'",
  );
  if ((foreignKey as Array<{ cnt: number }>)[0]?.cnt === 0)
    await runDdl(
      "ALTER TABLE documents ADD CONSTRAINT fk_doc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    );
}

async function migrateRedundantIndexes(): Promise<void> {
  for (const [table, index] of [
    ["password_reset_tokens", "idx_token"],
  ] as const) {
    const [rows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?",
      [table, index],
    );
    if ((rows as Array<{ cnt: number }>)[0]?.cnt > 0) {
      await pool.query(`ALTER TABLE ${table} DROP INDEX ${index}`);
    }
  }
}

async function migrateExtractedText(): Promise<void> {
  const [rows] = await pool.query(
    "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='documents' AND COLUMN_NAME='extracted_text'",
  );
  if ((rows as Array<{ cnt: number }>)[0]?.cnt === 0)
    await runDdl(
      "ALTER TABLE documents ADD COLUMN extracted_text MEDIUMTEXT NULL AFTER data",
    );
}

/**
 * Adds predicted_type to extraction_attempts (what each stage voted).
 * @returns void
 */
async function migrateAttempts(): Promise<void> {
  const [rows] = await pool.query(
    "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='extraction_attempts' AND COLUMN_NAME='predicted_type'",
  );
  if ((rows as Array<{ cnt: number }>)[0]?.cnt === 0) {
    await runDdl(
      "ALTER TABLE extraction_attempts ADD COLUMN predicted_type VARCHAR(50) NULL AFTER method",
    );
  }
  const [seqRows] = await pool.query(
    "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='extraction_attempts' AND COLUMN_NAME='seq'",
  );
  if ((seqRows as Array<{ cnt: number }>)[0]?.cnt === 0) {
    await runDdl(
      "ALTER TABLE extraction_attempts ADD COLUMN seq INT NOT NULL AUTO_INCREMENT, ADD UNIQUE KEY uq_attempt_seq (seq)",
    );
  }
  for (const [column, ddl] of [
    [
      "input_tokens",
      "ALTER TABLE extraction_attempts ADD COLUMN input_tokens INT NULL",
    ],
    [
      "output_tokens",
      "ALTER TABLE extraction_attempts ADD COLUMN output_tokens INT NULL",
    ],
  ]) {
    const [columnRows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='extraction_attempts' AND COLUMN_NAME=?",
      [column],
    );
    if ((columnRows as Array<{ cnt: number }>)[0]?.cnt === 0)
      await runDdl(ddl);
  }
}

/**
 * Migrates users table for verification code, profile fields support.
 * @returns void
 */
async function migrateUsers(): Promise<void> {
  const userCols: Array<[string, string]> = [
    [
      "verification_code",
      "ALTER TABLE users ADD COLUMN verification_code VARCHAR(10) NULL AFTER verification_token",
    ],
    [
      "verification_attempts",
      "ALTER TABLE users ADD COLUMN verification_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER verification_expires",
    ],
    [
      "first_name",
      "ALTER TABLE users ADD COLUMN first_name VARCHAR(50) NOT NULL DEFAULT '' AFTER email",
    ],
    [
      "last_name",
      "ALTER TABLE users ADD COLUMN last_name VARCHAR(50) NOT NULL DEFAULT '' AFTER first_name",
    ],
    [
      "phone",
      "ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL AFTER last_name",
    ],
  ];
  for (const [col, sql] of userCols) {
    const [rows] = await pool.query(
      "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME=?",
      [col],
    );
    if ((rows as Array<{ cnt: number }>)[0]?.cnt === 0) await runDdl(sql);
  }
  const [codeIdx] = await pool.query(
    "SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='users' AND INDEX_NAME='idx_verification_code'",
  );
  if ((codeIdx as Array<{ cnt: number }>)[0]?.cnt === 0)
    await runDdl(
      "ALTER TABLE users ADD INDEX idx_verification_code (verification_code)",
    );
}
