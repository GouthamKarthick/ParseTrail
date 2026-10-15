/**
 * routes/auth.route.ts — Authentication endpoints.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import {
  sendVerificationEmail,
  sendResetEmail,
} from "../services/email.service.js";
import { authenticate } from "../middleware/auth.js";
import { isSuspicious } from "../utils/security.js";
import { logger } from "../config/logger.js";

const router = Router();

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Z]/, "Password must contain at least 1 uppercase letter")
  .regex(/\d/, "Password must contain at least 1 number")
  .regex(/[^A-Za-z0-9]/, "Password must contain at least 1 special character");
const nameSchema = z.string().trim().min(1, "Required").max(50);
const registerSchema = z.object({
  first_name: nameSchema,
  last_name: nameSchema,
  email: z.string().email(),
  password: passwordSchema,
});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

/**
 * Signs a JWT for a user.
 * @param id User id
 * @param email User email
 * @returns JWT string
 */
function signToken(id: string, email: string) {
  return jwt.sign({ id, email }, config.jwtSecret, {
    expiresIn: config.jwtExpiry as unknown as jwt.SignOptions["expiresIn"],
  });
}

router.post("/register", async (req, res) => {
  if (
    isSuspicious(req.body?.email) ||
    isSuspicious(req.body?.password) ||
    isSuspicious(req.body?.first_name) ||
    isSuspicious(req.body?.last_name)
  ) {
    res.status(400).json({
      error: "Suspicious input detected — not saved",
      code: "SUSPICIOUS_INPUT",
    });
    return;
  }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    res.status(400).json({ error: msg || "Invalid registration data" });
    return;
  }
  const { first_name, last_name, email, password } = parsed.data;
  const hash = await bcrypt.hash(password, 10);
  const id = randomUUID();
  const verificationToken = randomUUID();
  const verificationCode = Math.floor(
    100000 + Math.random() * 900000,
  ).toString();
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  let verificationEmailSent = true;
  try {
    await pool.query(
      "INSERT INTO users (id, email, first_name, last_name, password_hash, verification_token, verification_code, verification_expires) VALUES (?,?,?,?,?,?,?,?)",
      [
        id,
        email.trim().toLowerCase(),
        first_name.trim(),
        last_name.trim(),
        hash,
        verificationToken,
        verificationCode,
        verificationExpires,
      ],
    );
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    throw e;
  }
  if (!config.smtp.host) {
    await pool.query(
      "UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_code=NULL, verification_expires=NULL WHERE id=?",
      [id],
    );
  } else {
    try {
      await sendVerificationEmail(email, verificationToken, verificationCode);
    } catch (error) {
      verificationEmailSent = false;
      logger.error("Verification email delivery failed after registration", {
        userId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const token = signToken(id, email);
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.status(201).json({
    id,
    email,
    first_name: first_name.trim(),
    last_name: last_name.trim(),
    email_verified: !config.smtp.host,
    verification_email_sent: verificationEmailSent,
  });
});

router.post("/login", async (req, res) => {
  if (isSuspicious(req.body?.email)) {
    res.status(400).json({
      error: "Suspicious input detected — not saved",
      code: "SUSPICIOUS_INPUT",
    });
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { email, password } = parsed.data;
  const [rows] = await pool.query(
    "SELECT id, email, first_name, last_name, password_hash, email_verified FROM users WHERE email=?",
    [email.trim().toLowerCase()],
  );
  const user = (
    rows as Array<{
      id: string;
      email: string;
      first_name: string;
      last_name: string;
      password_hash: string;
      email_verified: number;
    }>
  )[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (!user.email_verified) {
    res.status(403).json({
      error: "Email not verified. Please verify via code/link.",
      code: "EMAIL_NOT_VERIFIED",
    });
    return;
  }
  const token = signToken(user.id, user.email);
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    email_verified: Boolean(user.email_verified),
  });
});

router.post("/logout", (_req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", authenticate, async (req, res) => {
  const user = (req as unknown as { user: { id: string; email: string } }).user;
  const [rows] = await pool.query(
    "SELECT id, email, first_name, last_name, phone, email_verified, created_at FROM users WHERE id=?",
    [user.id],
  );
  const row = (rows as Array<Record<string, unknown>>)[0];
  if (!row) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(row);
});

/**
 * PATCH /api/auth/profile — phone always editable; first/last editable only
 * when currently empty (legacy accounts); email/avatar immutable here.
 */
router.patch("/profile", authenticate, async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if ("email" in body || "avatar_base64" in body) {
    res.status(400).json({
      error: "email and avatar_base64 are immutable via this endpoint",
    });
    return;
  }
  const user = (req as unknown as { user: { id: string } }).user;
  const [existing] = await pool.query(
    "SELECT first_name, last_name FROM users WHERE id=?",
    [user.id],
  );
  const current = (
    existing as Array<{ first_name: string | null; last_name: string | null }>
  )[0];

  const updates: string[] = [];
  const params: unknown[] = [];

  if ("first_name" in body || "last_name" in body) {
    const curFirstEmpty = !(current?.first_name || "").trim();
    const curLastEmpty = !(current?.last_name || "").trim();
    const wantFirst = body.first_name !== undefined;
    const wantLast = body.last_name !== undefined;
    if ((wantFirst && !curFirstEmpty) || (wantLast && !curLastEmpty)) {
      res
        .status(400)
        .json({ error: "first_name and last_name are immutable once set" });
      return;
    }
    if (wantFirst) {
      const v = String(body.first_name ?? "").trim();
      if (isSuspicious(v) || v.length < 1 || v.length > 50) {
        res.status(400).json({ error: "Invalid first_name" });
        return;
      }
      updates.push("first_name=?");
      params.push(v);
    }
    if (wantLast) {
      const v = String(body.last_name ?? "").trim();
      if (isSuspicious(v) || v.length < 1 || v.length > 50) {
        res.status(400).json({ error: "Invalid last_name" });
        return;
      }
      updates.push("last_name=?");
      params.push(v);
    }
  }

  if (body.phone !== undefined) {
    if (isSuspicious(body.phone as string)) {
      res.status(400).json({
        error: "Suspicious input detected — not saved",
        code: "SUSPICIOUS_INPUT",
      });
      return;
    }
    const phone =
      typeof body.phone === "string"
        ? body.phone.trim().replace(/[\s\-()]/g, "")
        : body.phone;
    if (
      phone !== undefined &&
      phone !== null &&
      phone !== "" &&
      !/^\+[1-9]\d{7,14}$/.test(phone as string)
    ) {
      res
        .status(400)
        .json({ error: "Phone must be E.164 format, e.g. +919876543210" });
      return;
    }
    updates.push("phone=?");
    params.push((phone as string) || null);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id=?`, [
    ...params,
    user.id,
  ]);
  const [rows] = await pool.query(
    "SELECT id, email, first_name, last_name, phone, email_verified FROM users WHERE id=?",
    [user.id],
  );
  res.json((rows as Array<Record<string, unknown>>)[0]);
});

/** Avatar helpers — separate API so GET /me stays light. */
function parseAvatarDataUrl(s: string): { mime: string; b64: string } | null {
  const m = s.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[3] };
}

router.get("/avatar", authenticate, async (req, res) => {
  const user = (req as unknown as { user: { id: string } }).user;
  const [rows] = await pool.query(
    "SELECT mime, data, size_bytes FROM user_avatars WHERE user_id=?",
    [user.id],
  );
  const row = (
    rows as Array<{ mime: string; data: string; size_bytes: number }>
  )[0];
  if (!row) {
    res.status(404).json({ avatar: null });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=300");
  res.json({
    avatar_base64: `data:${row.mime};base64,${row.data}`,
    mime: row.mime,
    size_bytes: row.size_bytes,
  });
});

router.put("/avatar", authenticate, async (req, res) => {
  const { avatar_base64 } = req.body as { avatar_base64?: string };
  if (!avatar_base64 || typeof avatar_base64 !== "string") {
    res.status(400).json({ error: "avatar_base64 required" });
    return;
  }
  if (avatar_base64.length > 1_400_000) {
    res.status(413).json({ error: "Avatar must be ≤1MB" });
    return;
  }
  const parsed = parseAvatarDataUrl(avatar_base64.trim());
  if (!parsed) {
    res.status(400).json({ error: "Avatar must be a jpeg/png/webp data URL" });
    return;
  }
  let size_bytes = 0;
  try {
    size_bytes = Buffer.from(parsed.b64, "base64").length;
  } catch {
    res.status(400).json({ error: "Invalid Base64" });
    return;
  }
  if (size_bytes > 1_048_576) {
    res.status(413).json({ error: "Avatar must be ≤1MB" });
    return;
  }
  const user = (req as unknown as { user: { id: string } }).user;
  await pool.query(
    "INSERT INTO user_avatars (user_id, mime, data, size_bytes) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE mime=VALUES(mime), data=VALUES(data), size_bytes=VALUES(size_bytes)",
    [user.id, parsed.mime, parsed.b64, size_bytes],
  );
  res.json({ ok: true, size_bytes });
});

router.delete("/avatar", authenticate, async (req, res) => {
  const user = (req as unknown as { user: { id: string } }).user;
  await pool.query("DELETE FROM user_avatars WHERE user_id=?", [user.id]);
  res.json({ ok: true });
});

router.post("/resend-verification", async (req, res) => {
  const email = (req.body?.email as string)?.trim()?.toLowerCase();
  if (!email) {
    res.status(400).json({ error: "Email required" });
    return;
  }
  const [rows] = await pool.query(
    "SELECT id, email_verified FROM users WHERE email=?",
    [email],
  );
  const user = (rows as Array<{ id: string; email_verified: number }>)[0];
  // Always ok to avoid enumeration; only send if unverified
  if (user && !user.email_verified) {
    const verificationToken = randomUUID();
    const verificationCode = Math.floor(
      100000 + Math.random() * 900000,
    ).toString();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      "UPDATE users SET verification_token=?, verification_code=?, verification_expires=? WHERE id=?",
      [verificationToken, verificationCode, verificationExpires, user.id],
    );
    try {
      await sendVerificationEmail(email, verificationToken, verificationCode);
    } catch (error) {
      logger.error("Verification email delivery failed", {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  res.json({ ok: true });
});

router.post("/verify-email", async (req, res) => {
  const token = (req.body?.token as string) || (req.query.token as string);
  const code = (req.body?.code as string) || (req.query.code as string);
  const email = (req.body?.email as string) || (req.query.email as string);
  const raw = token || code;
  if (isSuspicious(raw) || isSuspicious(email)) {
    res.status(400).json({
      error: "Suspicious input detected — not saved",
      code: "SUSPICIOUS_INPUT",
    });
    return;
  }
  if (token) {
    const [rows] = await pool.query(
      "SELECT id FROM users WHERE verification_token=? AND verification_expires > NOW()",
      [token],
    );
    const user = (rows as Array<{ id: string }>)[0];
    if (!user) {
      res.status(400).json({ error: "Invalid or expired token" });
      return;
    }
    await pool.query(
      "UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_code=NULL, verification_expires=NULL WHERE id=?",
      [user.id],
    );
    res.json({ ok: true });
    return;
  }
  if (!code) {
    res.status(400).json({ error: "Token or code required" });
    return;
  }
  const cleanCode = code.trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    res.status(400).json({ error: "Code must be 6 digits" });
    return;
  }
  let rows: unknown;
  if (email)
    [rows] = await pool.query(
      "SELECT id FROM users WHERE email=? AND verification_code=? AND verification_expires > NOW()",
      [email.trim().toLowerCase(), cleanCode],
    );
  else
    [rows] = await pool.query(
      "SELECT id FROM users WHERE verification_code=? AND verification_expires > NOW()",
      [cleanCode],
    );
  const user = (rows as Array<{ id: string }>)[0];
  if (!user) {
    res.status(400).json({ error: "Invalid or expired code" });
    return;
  }
  await pool.query(
    "UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_code=NULL, verification_expires=NULL WHERE id=?",
    [user.id],
  );
  res.json({ ok: true });
});

router.post("/forgot-password", async (req, res) => {
  const email = (req.body?.email as string)?.trim();
  if (isSuspicious(email)) {
    res.status(400).json({
      error: "Suspicious input detected — not saved",
      code: "SUSPICIOUS_INPUT",
    });
    return;
  }
  if (!email) {
    res.status(400).json({ error: "Email required" });
    return;
  }
  const [rows] = await pool.query("SELECT id FROM users WHERE email=?", [
    email,
  ]);
  const user = (rows as Array<{ id: string }>)[0];
  if (user) {
    const token = randomUUID();
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      "INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)",
      [randomUUID(), user.id, token, expires],
    );
    sendResetEmail(email, token).catch(() => {});
  }
  res.json({ ok: true });
});

router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body as { token?: string; password?: string };
  if (isSuspicious(token) || isSuspicious(password)) {
    res.status(400).json({
      error: "Suspicious input detected — not saved",
      code: "SUSPICIOUS_INPUT",
    });
    return;
  }
  const parsed = resetPasswordSchema.safeParse({ token, password });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    res.status(400).json({ error: msg || "Invalid token or password" });
    return;
  }
  const { token: validToken, password: validPassword } = parsed.data;
  const [rows] = await pool.query(
    "SELECT user_id FROM password_reset_tokens WHERE token=? AND expires_at > NOW() AND used=FALSE",
    [validToken],
  );
  const row = (rows as Array<{ user_id: string }>)[0];
  if (!row) {
    res.status(400).json({ error: "Invalid or expired token" });
    return;
  }
  const hash = await bcrypt.hash(validPassword, 10);
  await pool.query("UPDATE users SET password_hash=? WHERE id=?", [
    hash,
    row.user_id,
  ]);
  await pool.query("UPDATE password_reset_tokens SET used=TRUE WHERE token=?", [
    validToken,
  ]);
  res.json({ ok: true });
});

export default router;
