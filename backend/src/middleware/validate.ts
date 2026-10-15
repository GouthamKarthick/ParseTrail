/**
 * middleware/validate.ts — Request validation schemas and middleware.
 */

import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { isSuspicious } from "../utils/security.js";

const documentTypeValues = [
  "invoice",
  "receipt",
  "payment",
  "bill",
  "payslip",
  "settlement_slip",
  "other",
  "unknown",
] as const;

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(100).optional(),
  document_type: z.preprocess(
    (v) => {
      if (v === undefined || v === null) return undefined;
      const list = (Array.isArray(v) ? v : String(v).split(","))
        .map((s) => String(s).trim())
        .filter(Boolean);
      return list.length ? list : undefined;
    },
    z.array(z.enum(documentTypeValues)).optional(),
  ),
  document_category: z.enum(["financial", "unknown"]).optional(),
});

/**
 * Validates pagination and search query.
 * @param req Express request
 * @param _res Express response
 * @param next Next middleware
 * @returns void
 */
export function validatePagination(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const rawQ = (req.query.q as string) || "";
  if (rawQ && isSuspicious(rawQ)) {
    next({
      status: 400,
      message: "Suspicious input detected in search — not saved",
      code: "SUSPICIOUS_INPUT",
    });
    return;
  }
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const err: unknown = parsed.error;
    next({
      status: 400,
      message: "Invalid pagination",
      details: (err as Error).message,
    });
    return;
  }
  (req as unknown as Record<string, unknown>)._pagination = parsed.data;
  next();
}

export const uuidSchema = z.string().uuid();
