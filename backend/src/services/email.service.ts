/**
 * services/email.service.ts — Email sending via Nodemailer.
 */

import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../config/logger.js';

/**
 * Resolves the public frontend URL for email links.
 * @returns Frontend base URL
 */
function appUrl(): string {
  return process.env.FRONTEND_URL || process.env.APP_URL || `http://localhost:${config.port}`;
}

/**
 * Creates SMTP transport.
 * @returns Transport or null if not configured
 */
function getTransport() {
  if (!config.smtp.host) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('SMTP_HOST is required to send email in production');
    return null;
  }
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    connectionTimeout: config.smtp.timeoutMs,
    greetingTimeout: config.smtp.timeoutMs,
    socketTimeout: config.smtp.timeoutMs,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

/**
 * Sends verification email.
 * @param to Recipient email
 * @param token Verification token
 * @param code Optional 6-digit code
 * @returns void
 */
export async function sendVerificationEmail(to: string, token: string, code?: string) {
  const transport = getTransport();
  if (!transport) {
    logger.warn('SMTP not configured, skipping verification email');
    return;
  }
  const base = appUrl();
  const link = `${base}/verify-email?${new URLSearchParams({ token, email: to })}`;
  const codePart = code
    ? `\nYour verification code is: ${code} (expires in 15 minutes). Enter it at ${base}/verify-email`
    : '';
  const result = await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Verify your ParseTrail email',
    text: `Verify your email: ${link}${codePart}`,
    html: `<p>Click <a href="${link}">here</a> to verify your email (expires in 15 minutes).</p>${code ? `<p>Or enter this code in the app: <b style="font-size:18px; letter-spacing:2px;">${code}</b></p>` : ''}`,
  });
  if (result.rejected.length > 0 || result.accepted.length === 0)
    throw new Error('SMTP did not accept the verification recipient');
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
    logger.warn('SMTP not configured, skipping reset email');
    return;
  }
  const link = `${appUrl()}/reset-password?token=${token}`;
  const result = await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Reset your ParseTrail password',
    text: `Reset: ${link} (expires 1h)`,
    html: `<p>Click <a href="${link}">here</a> to reset password (1h).</p>`,
  });
  if (result.rejected.length > 0 || result.accepted.length === 0)
    throw new Error('SMTP did not accept the reset recipient');
}
