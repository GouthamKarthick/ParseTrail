/**
 * controllers/summary.controller.ts — Dashboard summary and export handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import { getSummary as getSummaryData } from '../services/summary.service.js';
import { generateSummaryPdf, generateSummaryCsv } from '../services/export.service.js';

/**
 * Returns summary aggregation.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function getSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const category =
      typeof req.query.category === 'string'
        ? req.query.category
        : typeof req.query.document_category === 'string'
          ? req.query.document_category
          : undefined;
    const summary = await getSummaryData(user.id, 30, category ? { category } : undefined);
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

/**
 * Exports summary as PDF or CSV.
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function exportSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const format = String(req.query.format || 'pdf').toLowerCase();
    const category =
      typeof req.query.category === 'string'
        ? req.query.category
        : typeof req.query.document_category === 'string'
          ? req.query.document_category
          : undefined;
    if (format === 'csv') {
      const csv = await generateSummaryCsv(user.id, category);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=parsetrail-summary-${new Date().toISOString().slice(0, 10)}.csv`
      );
      res.send(csv);
      return;
    }
    const pdf = await generateSummaryPdf(user.id, category);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=parsetrail-summary-${new Date().toISOString().slice(0, 10)}.pdf`
    );
    res.send(pdf);
  } catch (err) {
    next(err);
  }
}
