/**
 * index.ts — Application entry point.
 */

import fs from 'fs';
import { createApp } from './app.js';
import { ensureSchema } from './db/schema.js';
import { pool } from './db/pool.js';
import { config } from './config.js';
import { logger } from './config/logger.js';

if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });

const app = createApp();
let server: ReturnType<typeof app.listen> | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let cleanupCron: { stop: () => void } | null = null;
let stopWorker: (() => void) | null = null;
let shuttingDown = false;

async function initializeDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await ensureSchema();
      logger.info('Database schema ready');
      return;
    } catch (error) {
      logger.error(`Database initialization attempt ${attempt}/5 failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < 5)
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000))
        );
    }
  }
  throw new Error('Database initialization failed after 5 attempts');
}

async function initializeBackgroundJobs(): Promise<void> {
  if (shuttingDown) return;
  try {
    const { startRefineWorker } = await import('./jobs/refine.js');
    if (shuttingDown) return;
    stopWorker = startRefineWorker();
  } catch (error) {
    logger.error('Failed to start refine worker', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const { purgeExpired } = await import('./jobs/cleanup.js');
    if (shuttingDown) return;
    try {
      await purgeExpired();
    } catch (error) {
      logger.warn('Initial retention cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const cron = await import('node-cron');
    cleanupCron = cron.default.schedule('0 2 * * *', () => {
      void purgeExpired().catch(error =>
        logger.warn('Scheduled retention cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });
  } catch (error) {
    logger.warn('Failed to schedule retention cleanup', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutdown requested', { signal });
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exit(1);
  }, 8000);
  forceExit.unref();

  if (retryTimer) clearTimeout(retryTimer);
  cleanupCron?.stop();
  stopWorker?.();

  const serverClosed = server
    ? new Promise<void>(resolve => server!.close(() => resolve()))
    : Promise.resolve();
  try {
    const { releaseWorkingJobs } = await import('./jobs/refine.js');
    await releaseWorkingJobs();
  } catch (error) {
    logger.error('Could not release active refinement job', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let shutdownTimer: NodeJS.Timeout | undefined;
  const resourcesClosed = Promise.all([serverClosed, pool.end()]).then(
    () => true,
    error => {
      logger.error('Error while closing server resources', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  );
  const didClose = await Promise.race([
    resourcesClosed,
    new Promise<boolean>(resolve => {
      shutdownTimer = setTimeout(() => resolve(false), 6500);
    }),
  ]);
  if (shutdownTimer) clearTimeout(shutdownTimer);
  if (!didClose) {
    logger.warn('Forcing remaining HTTP connections closed');
    server?.closeAllConnections();
  }
  if (server && !server.listening) server = null;
  clearTimeout(forceExit);
  logger.info('Shutdown complete');
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`, {
    port: config.port,
    aiProviders: config.ai.providers,
  });
});

async function main(): Promise<void> {
  await initializeDatabase();
  initializeBackgroundJobs();
}

void main();
