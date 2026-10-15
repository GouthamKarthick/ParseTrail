/**
 * @fileoverview VerifyEmail page — handles link-token and 6-digit code verification flows.
 */

import { useEffect, useState } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { resendVerification } from "../api/client";
import { useAuth } from "../context/AuthContext";
import authStyles from "./Auth.module.scss";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Email verification page supporting both token link and manual code entry.
 * @returns VerifyEmail page element
 * @example <VerifyEmail />
 */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const token = params.get("token") || "";
  const presetEmail = params.get("email") || "";
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [msg, setMsg] = useState("");
  const [email, setEmail] = useState(presetEmail);
  const [code, setCode] = useState("");
  const [codeStatus, setCodeStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [codeMsg, setCodeMsg] = useState("");
  const [resendMsg, setResendMsg] = useState("");

  useEffect(() => {
    if (!token) return;
    setStatus("loading");
    fetch(
      `${import.meta.env.VITE_BACKEND_URL || import.meta.env.VITE_API_URL || ""}/api/auth/verify-email`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    )
      .then(async (r) => {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        if (r.ok) {
          setStatus("success");
          setMsg("Email verified! Continue to setup your profile.");
          refresh().catch(() => {});
        } else {
          setStatus("error");
          setMsg(b.error || "Invalid or expired token");
        }
      })
      .catch((e) => {
        setStatus("error");
        setMsg((e as Error).message);
      });
  }, [token, refresh]);

  /**
   * Submit 6-digit verification code.
   * @param e - Form submit event
   */
  async function onCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    if (!/^\d{6}$/.test(code.trim())) {
      setCodeStatus("error");
      setCodeMsg("Code must be 6 digits");
      return;
    }

    setCodeStatus("loading");
    setCodeMsg("");
    try {
      const body: Record<string, string> = { code: code.trim() };

      if (email.trim()) body.email = email.trim();

      const r = await fetch(
        `${import.meta.env.VITE_BACKEND_URL || import.meta.env.VITE_API_URL || ""}/api/auth/verify-email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      const b = (await r.json().catch(() => ({}))) as { error?: string };

      if (r.ok) {
        setCodeStatus("success");
        setCodeMsg("Email verified! Continue to setup your profile.");
        refresh().catch(() => {});
      } else {
        setCodeStatus("error");
        setCodeMsg(b.error || "Invalid or expired code");
      }
    } catch (e) {
      setCodeStatus("error");
      setCodeMsg((e as Error).message);
    }
  }

  async function onResend() {
    if (!email.trim()) {
      setResendMsg("Enter your email first");
      return;
    }

    try {
      await resendVerification(email.trim());
      setResendMsg(
        "If the account exists and needs verification, a new code was requested. Check spam; if it does not arrive, try again later.",
      );
    } catch {
      setResendMsg("Unable to request a code right now. Please try again later.");
    }
  }

  return (
    <div className={authStyles["auth-card"]}>
      <h2>Verify Email</h2>
      <p className={authStyles["auth-hint"]}>
        Check your inbox for a verification email with a 6-digit code and a
        link. Click the link to auto-verify, or type the code below.
      </p>

      {token ? (
        <div className={authStyles["auth-verify-box"]}>
          {status === "loading" && <p>Verifying via link…</p>}
          {status === "success" && (
            <p className={authStyles["auth-hint--success"]}>
              {msg}
              <button
                className={authStyles["auth-verify-btn"]}
                onClick={() => nav("/setup-profile")}
              >
                Continue to setup
              </button>
            </p>
          )}
          {status === "error" && (
            <p className={authStyles["auth-hint--error"]}>{msg}</p>
          )}
          {(!status || status === "idle") && (
            <p>
              Token: <code>{token.slice(0, 8)}…</code>
            </p>
          )}
        </div>
      ) : (
        <p className={authStyles["auth-hint"]}>
          No link token — enter code manually below. Link format:{" "}
          <code>/verify-email?token=...</code>
        </p>
      )}

      <form onSubmit={onCodeSubmit} className={authStyles["auth-verify-form"]}>
        <h3 className={authStyles["auth-label"]}>Verify with code</h3>
        <label className={authStyles["auth-label"]}>
          Email (optional, helps if code not unique)
        </label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          type="email"
          className={authStyles["auth-input"]}
        />
        <label className={authStyles["auth-label"]}>6-digit code</label>
        <input
          value={code}
          onChange={(e) =>
            setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          placeholder="123456"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          className={authStyles["auth-code-input"]}
          required
        />
        <button
          type="submit"
          disabled={codeStatus === "loading"}
          className={authStyles["auth-verify-btn"]}
        >
          {codeStatus === "loading" ? "Verifying…" : "Verify via code"}
        </button>
        {codeStatus === "success" && (
          <p className={authStyles["auth-hint--success"]}>
            {codeMsg}
            <button
              type="button"
              className={authStyles["auth-verify-btn"]}
              onClick={() => nav("/setup-profile")}
            >
              Continue to setup
            </button>
          </p>
        )}
        {codeStatus === "error" && (
          <p className={authStyles["auth-hint--error"]}>{codeMsg}</p>
        )}
      </form>

      <p className={authStyles["auth-center"] + " " + authStyles["auth-hint"]}>
        Didn’t get email?{" "}
        <button className={authStyles["auth-link"]} onClick={onResend}>
          Resend code
        </button>{" "}
        {resendMsg} Check spam (code expires in 24h) or{" "}
        <Link to="/register" className={authStyles["auth-link"]}>
          register again
        </Link>
        .
      </p>
    </div>
  );
}
