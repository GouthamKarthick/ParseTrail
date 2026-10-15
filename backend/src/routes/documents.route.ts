/**
 * routes/documents.route.ts — Document API routes.
 */

import { Router } from "express";
import { upload } from "../middleware/upload.js";
import { validatePagination } from "../middleware/validate.js";
import {
  uploadDocument,
  listDocuments,
  getDocument,
  getAttempts,
  reprocessDocument,
  retryDocumentRefinement,
  correctField,
  listCorrections,
  correctionStats,
  getSummary,
  exportSummary,
} from "../controllers/documents.controller.js";

const router = Router();

router.post("/documents/upload", upload.single("file"), uploadDocument);
router.get("/documents/summary", getSummary);
router.get("/documents/summary/export", exportSummary);
router.get("/documents", validatePagination, listDocuments);
router.get("/documents/:id/attempts", getAttempts);
router.post("/documents/:id/refinement/retry", retryDocumentRefinement);
router.post("/documents/:id/reprocess", reprocessDocument);
router.post("/documents/:id/corrections", correctField);
router.get("/documents/:id/corrections", listCorrections);
router.get("/documents/corrections/stats", correctionStats);
router.get("/documents/:id", getDocument);

export default router;
