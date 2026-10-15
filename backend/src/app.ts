/**
 * app.ts — Express application factory with middleware, logging, and routes.
 */

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import documentsRouter from "./routes/documents.route.js";
import authRouter from "./routes/auth.route.js";
import { authenticate } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error.js";
import { logger } from "./config/logger.js";

/**
 * Creates and configures the Express application.
 * @returns Configured Express app
 */
export function createApp() {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.url}`, {
      method: req.method,
      url: req.url,
    });
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/health/db", async (_req, res) => {
    try {
      const { pool } = await import("./db/pool.js");
      await pool.query("SELECT 1 as ok");
      res.json({ status: "ok", db: "up" });
    } catch (e) {
      res.status(503).json({
        status: "degraded",
        db: "down",
        error: (e as Error).message.slice(0, 200),
        hint: "Check Aiven service type (MySQL vs MariaDB) and DB_HOST/DB_PORT/DB_CA_CERT",
      });
    }
  });

  app.use("/api/auth", authRouter);
  app.use("/api", authenticate, documentsRouter);
  app.use(errorHandler);

  return app;
}
