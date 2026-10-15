/**
 * services/email.service.ts — Email sending via Nodemailer.
 */

import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "../config/logger.js";

/**
 * Creates SMTP transport.
 * @returns Transport or null if not configured
 */
function getTransport() {
  if (!config.smtp.host) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  });
}

/**
 * Sends verification email.
 * @param to Recipient email
 * @param token Verification token
 * @param code Optional 6-digit code
 * @returns void
 */
export async function sendVerificationEmail(
  to: string,
  token: string,
  code?: string,
) {
  const transport = getTransport();
  if (!transport) {
    logger.warn("SMTP not configured, skipping verification email", { to });
    return;
  }
  const appUrl =
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    `http://localhost:${config.port}`;
  const link = `${appUrl}/verify-email?token=${token}`;
  const codePart = code
    ? `\nYour verification code is: ${code} (expires in 24h). Enter it at ${appUrl}/verify-email`
    : "";
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: "Verify your ClarityDocs email",
    text: `Verify your email: ${link}${codePart}`,
    html: `<p>Click <a href="${link}">here</a> to verify your email (expires in 24h).</p>${code ? `<p>Or enter this code in the app: <b style="font-size:18px; letter-spacing:2px;">${code}</b></p>` : ""}<p>Code: <b>${code ?? ""}</b> — type it at <a href="${appUrl}/verify-email">${appUrl}/verify-email</a></p>`,
  });
}

/**
 * Sends password reset email.
 * @param to Recipient email
 * @param token Reset token
 * @returns void
 */
export async function sendResetEmail(to: string, token: string) {
  const transport = getTransport();
  if (!transport) {
    logger.warn("SMTP not configured, skipping reset email", { to });
    return;
  }
  const appUrl =
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    `http://localhost:${config.port}`;
  const link = `${appUrl}/reset-password?token=${token}`;
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: "Reset your ClarityDocs password",
    text: `Reset: ${link} (expires 1h)`,
    html: `<p>Click <a href="${link}">here</a> to reset password (1h).</p>`,
  });
}
