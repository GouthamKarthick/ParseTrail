/**
 * routes/documents.route.ts — Document API routes.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { upload } from '../middleware/upload.js';
import { validatePagination } from '../middleware/validate.js';
import {
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  getAttempts,
  reprocessDocument,
  retryDocumentRefinement,
  correctField,
  listCorrections,
  correctionStats,
  getSummary,
  exportSummary,
} from '../controllers/documents.controller.js';

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
    return `ip:${(req as { ip?: string }).ip || 'unknown'}`;
  },
  handler(_req, res) {
    res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
  },
});

router.post('/documents/upload', upload.single('file'), uploadDocument);
router.get('/documents/summary', getSummary);
router.get('/documents/summary/export', exportSummary);
router.get('/documents', validatePagination, listDocuments);
router.get('/documents/:id/attempts', getAttempts);
router.post('/documents/:id/refinement/retry', expensiveRouteLimit, retryDocumentRefinement);
router.post('/documents/:id/reprocess', expensiveRouteLimit, reprocessDocument);
router.post('/documents/:id/corrections', correctField);
router.get('/documents/:id/corrections', listCorrections);
router.get('/documents/corrections/stats', correctionStats);
router.get('/documents/:id', getDocument);
router.delete('/documents/:id', deleteDocument);

export default router;
