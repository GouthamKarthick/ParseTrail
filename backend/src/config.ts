/**
 * config.ts — Centralized environment configuration.
 */

import dotenv from "dotenv";

dotenv.config();

/**
 * Cleans env value by stripping stray quotes/spaces.
 * @param v Raw env value
 * @returns Cleaned value or undefined
 */
function cleanVal(v?: string): string | undefined {
  if (!v) return undefined;
  return (
    v
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .trim() || undefined
  );
}

/**
 * Parses a positive-int env value with fallback.
 * @param v Raw env value
 * @param fallback Fallback when missing/non-positive
 * @returns Parsed value or fallback
 */
function parsePositiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  uploadDir: process.env.UPLOAD_DIR || "./uploads",
  maxFileSize: Number(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024,
  db: {
    host: cleanVal(process.env.DB_HOST) || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: cleanVal(process.env.DB_USER) || "clarity_user",
    password: cleanVal(process.env.DB_PASSWORD) || "clarity_pass",
    database: cleanVal(process.env.DB_NAME) || "clarity_docs",
    ssl:
      process.env.DB_SSL === "true" ||
      (cleanVal(process.env.DB_HOST) || "").includes("aivencloud.com"),
    sslCaPath: cleanVal(process.env.DB_CA_PATH) || "./ca.pem",
    sslCa: cleanVal(process.env.DB_CA_CERT) || "",
  },
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  jwtExpiry: process.env.JWT_EXPIRY || "1d",
  retentionDays: Number(process.env.RETENTION_DAYS) || 30,
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "noreply@claritydocs.local",
  },
  ai: {
    provider:
      (process.env.AI_PROVIDER as "google" | "anthropic" | "openai") ||
      "google",
    model: process.env.AI_MODEL || "gemini-flash-latest",
    apiKey: process.env.AI_API_KEY || "",
    threshold: Number(process.env.AI_CONFIDENCE_THRESHOLD) || 0.5,
  },
  logs: {
    dir: "./logs",
    level: process.env.LOG_LEVEL || "debug",
  },
  currencyConversion: {
    url: process.env.CURRENCY_CONVERSION_URL || "https://api.frankfurter.app",
    fallbackUrl:
      process.env.CURRENCY_CONVERSION_FALLBACK_URL ||
      "https://open.er-api.com/v6/latest",
    targetCurrency:
      (process.env.DISPLAY_CURRENCY || "INR").trim().toUpperCase() || "INR",
    cacheTtlMs: parsePositiveInt(
      process.env.CURRENCY_CONVERSION_CACHE_TTL_MS,
      5 * 60 * 1000,
    ),
    timeoutMs: parsePositiveInt(
      process.env.CURRENCY_CONVERSION_TIMEOUT_MS,
      3000,
    ),
  },
} as const;
