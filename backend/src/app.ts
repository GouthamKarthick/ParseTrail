/**
 * app.ts — Express application factory with middleware, logging, and routes.
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createHash } from 'node:crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import documentsRouter from './routes/documents.route.js';
import authRouter from './routes/auth.route.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler } from './middleware/error.js';
import { logger } from './config/logger.js';
import { config } from './config.js';
import rateLimit from 'express-rate-limit';

/**
 * Creates and configures the Express application.
 * @returns Configured Express app
 */
export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, !origin || config.corsOrigins.includes(origin));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`, {
      method: req.method,
      path: req.path,
    });
    next();
  });

  const ipRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const emailRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator(req) {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (email) {
        return `email:${createHash('sha256').update(email).digest('hex')}`;
      }
      return `ip:${ipKeyGenerator(req.ip || 'unknown')}`;
    },
    handler(_req, res) {
      res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
    },
  });
  app.use('/api/auth/login', ipRateLimit, emailRateLimit);
  app.use('/api/auth/register', ipRateLimit, emailRateLimit);
  app.use('/api/auth/forgot-password', ipRateLimit, emailRateLimit);
  app.use('/api/auth/resend-verification', ipRateLimit, emailRateLimit);
  app.use('/api/auth/verify-email', ipRateLimit, emailRateLimit);
  app.use(
    '/api/documents/upload',
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/health/db', async (_req, res) => {
    try {
      const { pool } = await import('./db/pool.js');
      await pool.query('SELECT 1 as ok');
      res.json({ ok: true });
    } catch (error) {
      logger.error('Database health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api', authenticate, documentsRouter);
  app.use(errorHandler);

  return app;
}
