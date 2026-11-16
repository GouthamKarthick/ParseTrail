/**
 * controllers/refine.controller.ts — Document reprocessing and refinement retry handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool.js';
import { enqueueRefineJob, retryRefineJobNow } from '../jobs/refine.js';
import { findDocumentByIdAndUser } from './documents.controller.js';

/**
 * Reprocess a document: enqueues a background refine job instead of running
 * extraction inline, so uploads stay fast and user corrections are never lost
 * (the worker re-applies them via withCorrectionsReapplied).
 * @param req Express request
 * @param res Express response
 * @param next Next middleware
 * @returns void
 */
export async function reprocessDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const id = req.parsedId!;
    const row = await findDocumentByIdAndUser(id, user.id, res, 'id, path');
    if (!row) return;
    await pool.query("UPDATE documents SET status='processing', error=NULL WHERE id=?", [id]);
    await enqueueRefineJob(id, user.id, 'reprocess');
    res.status(202).json({
      id,
      status: 'processing',
      enqueued: true,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Immediately retries cloud refinement for an owned completed document.
 */
export async function retryDocumentRefinement(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const id = req.parsedId!;
    const row = await findDocumentByIdAndUser(id, user.id, res, 'id, status');
    if (!row) return;
    const doc = row as { id: string; status: string };
    if (doc.status !== 'done') {
      res.status(409).json({ error: 'Only completed documents can be refined' });
      return;
    }
    const status = await retryRefineJobNow(doc.id, user.id);
    if (status === 'working') {
      res.status(409).json({ error: 'Refinement is already in progress' });
      return;
    }
    res.status(202).json({ id: doc.id, status, enqueued: true });
  } catch (err) {
    next(err);
  }
}
