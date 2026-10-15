/**
 * middleware/upload.ts — Multer upload handling.
 */

import multer from "multer";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { config } from "../config.js";

if (!fs.existsSync(config.uploadDir))
  fs.mkdirSync(config.uploadDir, { recursive: true });

const allowedMimes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

/** Multer instance for document uploads. */
export const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, config.uploadDir);
    },
    filename(_req, file, cb) {
      const id = randomUUID();
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${id}-${safe}`);
    },
  }),
  limits: { fileSize: config.maxFileSize },
  fileFilter(_req, file, cb) {
    if (!allowedMimes.has(file.mimetype)) {
      cb(new Error(`Invalid file type. Allowed: pdf, png, jpg`));
      return;
    }
    if (
      file.originalname.includes("..") ||
      /[<>]/.test(file.originalname) ||
      file.originalname.length > 255
    ) {
      cb(new Error(`Suspicious file name — not saved`));
      return;
    }
    cb(null, true);
  },
});
