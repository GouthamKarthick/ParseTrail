/**
 * middleware/error.ts — Global error handler.
 */

import type { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger.js";

/**
 * Handles validation and unexpected errors.
 * @param err Error object
 * @param req Express request
 * @param res Express response
 * @param _next Next middleware
 * @returns void
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const maybeStatus = (err as { status?: number })?.status;
  if (maybeStatus) {
    res.status(maybeStatus).json({
      error: (err as { message?: string }).message || "Bad request",
      code: (err as { code?: string }).code,
    });
    return;
  }
  if (err instanceof Error) {
    if (err.message.includes("Invalid file type")) {
      res.status(400).json({ error: err.message });
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File too large. Max 10MB." });
      return;
    }
  }
  logger.error("Unhandled error", {
    method: req.method,
    url: req.originalUrl,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({ error: "Internal server error" });
}
