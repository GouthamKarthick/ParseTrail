/**
 * routes/documents.route.ts — Document API routes.
 */

import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { upload } from '../middleware/upload.js';
import { validatePagination, validateIdParam } from '../middleware/validate.js';
import { requireUser } from '../middleware/auth.js';
import {
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  getAttempts,
} from '../controllers/documents.controller.js';
import { reprocessDocument, retryDocumentRefinement } from '../controllers/refine.controller.js';
import {
  correctField,
  listCorrections,
  correctionStats,
} from '../controllers/corrections.controller.js';
import { getSummary, exportSummary } from '../controllers/summary.controller.js';

const router = Router();

// Per-user (fallback per-IP) rate limiter for expensive document routes.
const expensiveRouteLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    const userId = (req as { user?: { id?: string } }).user?.id;
    if (userId) return `user:${userId}`;
    return `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
  handler(_req, res) {
    res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
  },
});

router.post('/documents/upload', requireUser, upload.single('file'), uploadDocument);
router.get('/documents/summary', requireUser, getSummary);
router.get('/documents/summary/export', requireUser, exportSummary);
router.get('/documents', requireUser, validatePagination, listDocuments);
router.get('/documents/:id/attempts', requireUser, validateIdParam, getAttempts);
router.post(
  '/documents/:id/refinement/retry',
  requireUser,
  expensiveRouteLimit,
  validateIdParam,
  retryDocumentRefinement
);
router.post(
  '/documents/:id/reprocess',
  requireUser,
  expensiveRouteLimit,
  validateIdParam,
  reprocessDocument
);
router.post('/documents/:id/corrections', requireUser, validateIdParam, correctField);
router.get('/documents/:id/corrections', requireUser, validateIdParam, listCorrections);
router.get('/documents/corrections/stats', requireUser, correctionStats);
router.get('/documents/:id', requireUser, validateIdParam, getDocument);
router.delete('/documents/:id', requireUser, validateIdParam, deleteDocument);

export default router;
