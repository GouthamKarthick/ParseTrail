/**
 * services/config.spec.ts — Centralized env config validation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const baseEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in baseEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    process.env[key] = value;
  }
  vi.resetModules();
});

async function importConfig(
  overrides: Record<string, string | undefined>
): Promise<typeof import('./config.js')> {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('./config.js');
}

describe('config', () => {
  it('loads values from env and exposes isProduction', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.DB_HOST = 'db';
    process.env.DB_USER = 'u';
    process.env.DB_PASSWORD = 'p';
    process.env.DB_NAME = 'd';
    process.env.FRONTEND_URL = 'https://app.example.com';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.COOKIE_SAME_SITE = 'lax';
    process.env.AI_API_KEY = 'gemini-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';

    const mod = await importConfig({});

    expect(mod.config.isProduction).toBe(true);
    expect(mod.config.db.host).toBe('db');
    expect(mod.config.db.user).toBe('u');
    expect(mod.config.db.password).toBe('p');
    expect(mod.config.db.database).toBe('d');
    expect(mod.config.jwtSecret).toHaveLength(64);
    expect(mod.config.frontendUrl).toBe('https://app.example.com');
    expect(mod.config.cookieSameSite).toBe('lax');
    expect(mod.config.localLlmModel).toBe('Xenova/LaMini-Flan-T5-77M');
    expect(mod.config.ai.providerKeys.gemini?.model).toBe('gemini-flash-latest');
    expect(mod.config.ai.providerKeys.groq?.model).toBe('llama-3.3-70b-versatile');
    expect(mod.config.ai.providerKeys.openrouter?.model).toBe(
      'meta-llama/llama-3.3-70b-instruct:free'
    );
  });

  it('isProduction is false outside production', async () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.DB_HOST = 'db';
    process.env.DB_USER = 'u';
    process.env.DB_PASSWORD = 'p';
    process.env.DB_NAME = 'd';

    const mod = await importConfig({});
    expect(mod.config.isProduction).toBe(false);
  });

  it('throws in production when JWT_SECRET is missing', async () => {
    await expect(
      importConfig({
        NODE_ENV: 'production',
        JWT_SECRET: undefined,
        DB_HOST: 'db',
        DB_USER: 'u',
        DB_PASSWORD: 'p',
        DB_NAME: 'd',
        FRONTEND_URL: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
      })
    ).rejects.toThrow(/JWT_SECRET/);
  });

  it('throws in production when JWT_SECRET is under 32 chars', async () => {
    await expect(
      importConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'short',
        DB_HOST: 'db',
        DB_USER: 'u',
        DB_PASSWORD: 'p',
        DB_NAME: 'd',
        FRONTEND_URL: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
      })
    ).rejects.toThrow(/32 characters/);
  });

  it('throws in production when DB credentials are missing', async () => {
    await expect(
      importConfig({
        NODE_ENV: 'production',
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        DB_HOST: undefined,
        DB_USER: 'u',
        DB_PASSWORD: 'p',
        DB_NAME: 'd',
        FRONTEND_URL: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
      })
    ).rejects.toThrow(/DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME/);
  });

  it('throws in production when ALLOW_UNVERIFIED is true', async () => {
    await expect(
      importConfig({
        NODE_ENV: 'production',
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        DB_HOST: 'db',
        DB_USER: 'u',
        DB_PASSWORD: 'p',
        DB_NAME: 'd',
        FRONTEND_URL: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
        ALLOW_UNVERIFIED: 'true',
      })
    ).rejects.toThrow(/ALLOW_UNVERIFIED/);
  });

  it('throws in production when FRONTEND_URL is missing', async () => {
    await expect(
      importConfig({
        NODE_ENV: 'production',
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        DB_HOST: 'db',
        DB_USER: 'u',
        DB_PASSWORD: 'p',
        DB_NAME: 'd',
        FRONTEND_URL: undefined,
        SMTP_HOST: 'smtp.example.com',
      })
    ).rejects.toThrow(/FRONTEND_URL/);
  });

  it('throws in production when SMTP_HOST is missing', async () => {
    await expect(
      importConfig({
        NODE_ENV: 'production',
        JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        DB_HOST: 'db',
        DB_USER: 'u',
        DB_PASSWORD: 'p',
        DB_NAME: 'd',
        FRONTEND_URL: 'https://app.example.com',
        SMTP_HOST: undefined,
      })
    ).rejects.toThrow(/SMTP_HOST/);
  });

  it('requires JWT_SECRET and DB credentials outside test', async () => {
    process.env.NODE_ENV = 'development';
    await expect(
      importConfig({
        JWT_SECRET: undefined,
        DB_HOST: 'db',
        DB_USER: 'u',
        DB_PASSWORD: 'p',
        DB_NAME: 'd',
      })
    ).rejects.toThrow(/JWT_SECRET/);
  });

  it('does not require JWT_SECRET/DB in test environment', async () => {
    process.env.NODE_ENV = 'test';
    const mod = await importConfig({ JWT_SECRET: undefined, DB_HOST: undefined });
    expect(mod.config).toBeDefined();
  });

  it('throws on invalid COOKIE_SAME_SITE value', async () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.DB_HOST = 'db';
    process.env.DB_USER = 'u';
    process.env.DB_PASSWORD = 'p';
    process.env.DB_NAME = 'd';
    process.env.COOKIE_SAME_SITE = 'invalid';

    await expect(importConfig({})).rejects.toThrow(/COOKIE_SAME_SITE/);
  });
});
