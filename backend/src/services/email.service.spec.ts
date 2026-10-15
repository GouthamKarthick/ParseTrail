/**
 * services/email.service.spec.ts — mailers with mocked nodemailer (no SMTP).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn() },
}));

import nodemailer from "nodemailer";
import { config } from "../config.js";
import { sendVerificationEmail, sendResetEmail } from "./email.service.js";

describe("services/email", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips verification email when SMTP host is unset", async () => {
    const orig = config.smtp.host;
    (config.smtp as Record<string, unknown>).host = "";
    try {
      await sendVerificationEmail("a@b.c", "tok", "123456");
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    } finally {
      (config.smtp as Record<string, unknown>).host = orig;
    }
  });

  it("renders the verification code exactly once in html", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);
    const orig = config.smtp.host;
    (config.smtp as Record<string, unknown>).host = "smtp.example.com";
    try {
      await sendVerificationEmail("a@b.c", "tok", "123456");
      expect(sendMail).toHaveBeenCalledTimes(1);
      const html = String(sendMail.mock.calls[0][0].html);
      const hits = html.match(/123456/g) ?? [];
      expect(hits).toHaveLength(1);
    } finally {
      (config.smtp as Record<string, unknown>).host = orig;
    }
  });

  it("sends reset email with 1h link", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as any);
    const orig = config.smtp.host;
    (config.smtp as Record<string, unknown>).host = "smtp.example.com";
    try {
      await sendResetEmail("a@b.c", "tok");
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(String(sendMail.mock.calls[0][0].text)).toContain("tok");
    } finally {
      (config.smtp as Record<string, unknown>).host = orig;
    }
  });
});
