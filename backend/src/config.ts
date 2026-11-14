/**
 * config.ts — Centralized environment configuration.
 */

import dotenv from 'dotenv';

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
      .replace(/^['"]|['"]$/g, '')
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

const configuredProviders = (process.env.AI_PROVIDERS || process.env.AI_PROVIDER || 'gemini')
  .split(',')
  .map(provider => provider.trim().toLowerCase())
  .filter(Boolean)
  .map(provider => (provider === 'google' ? 'gemini' : provider));
if (configuredProviders.length === 0)
  throw new Error('AI_PROVIDERS must contain at least one provider');
const supportedProviders = new Set(['gemini', 'groq', 'openrouter', 'anthropic']);
const unknownProvider = configuredProviders.find(provider => !supportedProviders.has(provider));
if (unknownProvider) {
  throw new Error(`Unsupported AI provider: ${unknownProvider}`);
}

function isCookieSameSite(value: string): value is 'lax' | 'strict' | 'none' {
  return value === 'lax' || value === 'strict' || value === 'none';
}

const cookieSameSiteValue =
  cleanVal(process.env.COOKIE_SAME_SITE) ||
  (process.env.NODE_ENV === 'production' ? 'none' : 'lax');
if (!isCookieSameSite(cookieSameSiteValue)) {
  throw new Error('COOKIE_SAME_SITE must be lax, strict, or none');
}

export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT) || 4000,
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  maxFileSize: Number(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024,
  db: {
    host: cleanVal(process.env.DB_HOST) || '',
    port: Number(process.env.DB_PORT) || 3306,
    user: cleanVal(process.env.DB_USER) || '',
    password: cleanVal(process.env.DB_PASSWORD) || '',
    database: cleanVal(process.env.DB_NAME) || '',
    ssl: process.env.DB_SSL === 'true',
    sslCaPath: cleanVal(process.env.DB_CA_PATH) || './ca.pem',
    sslCa: cleanVal(process.env.DB_CA_CERT) || '',
  },
  jwtSecret: cleanVal(process.env.JWT_SECRET) || '',
  jwtExpiry: process.env.JWT_EXPIRY || '1d',
  cookieSameSite: cookieSameSiteValue,
  frontendUrl: cleanVal(process.env.FRONTEND_URL) || cleanVal(process.env.APP_URL) || '',
  allowUnverified: process.env.ALLOW_UNVERIFIED === 'true',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  retentionDays: parsePositiveInt(process.env.RETENTION_DAYS, 30),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'noreply@parsetrail.local',
    timeoutMs: parsePositiveInt(process.env.SMTP_TIMEOUT_MS, 10_000),
  },
  ai: {
    providers: configuredProviders as Array<'gemini' | 'groq' | 'openrouter' | 'anthropic'>,
    model: process.env.AI_MODEL || 'gemini-flash-latest',
    apiKey: process.env.AI_API_KEY || '',
    groqApiKey: process.env.GROQ_API_KEY || '',
    openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    openRouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    timeoutMs: parsePositiveInt(process.env.AI_TIMEOUT_MS, 20_000),
  },
  refine: {
    pollMs: parsePositiveInt(process.env.REFINE_POLL_MS, 15_000),
    dailyCap: parsePositiveInt(process.env.REFINE_DAILY_CAP, 100),
    maxAttempts: parsePositiveInt(process.env.REFINE_MAX_ATTEMPTS, 5),
    ratePerMinute: parsePositiveInt(process.env.REFINE_RATE_PER_MIN, 10),
  },
  localLlmEnabled: process.env.LOCAL_LLM_ENABLED !== 'false',
  localLlmModel: process.env.LOCAL_LLM_MODEL || 'Xenova/LaMini-Flan-T5-77M',
  ocrMaxPages: parsePositiveInt(process.env.OCR_MAX_PAGES, 3),
  logs: {
    dir: './logs',
    level: process.env.LOG_LEVEL || 'debug',
  },
  currencyConversion: {
    url: process.env.CURRENCY_CONVERSION_URL || 'https://api.frankfurter.app',
    fallbackUrl:
      process.env.CURRENCY_CONVERSION_FALLBACK_URL || 'https://open.er-api.com/v6/latest',
    targetCurrency: (process.env.DISPLAY_CURRENCY || 'INR').trim().toUpperCase() || 'INR',
    cacheTtlMs: parsePositiveInt(process.env.CURRENCY_CONVERSION_CACHE_TTL_MS, 5 * 60 * 1000),
    timeoutMs: parsePositiveInt(process.env.CURRENCY_CONVERSION_TIMEOUT_MS, 3000),
  },
} as const;

const isTest = process.env.NODE_ENV === 'test';

if (config.isProduction) {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters in production');
  }
  if (!config.db.host || !config.db.user || !config.db.password || !config.db.database) {
    throw new Error('DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME are required in production');
  }
  if (config.allowUnverified) {
    throw new Error('ALLOW_UNVERIFIED must not be true in production');
  }
  if (!config.frontendUrl) {
    throw new Error('FRONTEND_URL is required in production');
  }
  if (!config.smtp.host) {
    throw new Error('SMTP_HOST is required in production');
  }
}

// Require secrets and DB credentials outside test (tests keep working via .env).
if (!isTest) {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters');
  }
  if (!config.db.host || !config.db.user || !config.db.password || !config.db.database) {
    throw new Error('DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME must be set');
  }
}
