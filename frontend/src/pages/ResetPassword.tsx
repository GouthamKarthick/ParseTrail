/**
 * @fileoverview ResetPassword page — set new password using reset token.
 */

import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { resetPassword } from "../api/client";
import { getPasswordError } from "../utils/security";
import authStyles from "./Auth.module.scss";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Reset password via token from query string.
 * @returns ResetPassword page element
 * @example <ResetPassword />
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [pwd, setPwd] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  /**
   * Validate and submit new password.
   * @param e - Form submit event
   */
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const pwErr = getPasswordError(pwd);
    if (pwErr) {
      setErr(pwErr);
      return;
    }
    setErr(null);
    try {
      await resetPassword(token, pwd);
      nav("/login");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className={authStyles["auth-card"]}>
      <h2>Reset Password</h2>
      <form onSubmit={onSubmit} className={authStyles["auth-field"]}>
        <div className={authStyles["auth-input-wrap"]}>
          <input
            type={show ? "text" : "password"}
            placeholder="8+ chars, 1 uppercase, 1 number, 1 special"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            className={authStyles["auth-input--with-icon"]}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className={authStyles["auth-toggle"]}
          >
            <i className={show ? "bi bi-eye-slash" : "bi bi-eye"} aria-hidden />
          </button>
        </div>
        <ul className={authStyles["auth-list"]}>
          <li
            className={
              pwd.length >= 8 ? authStyles["auth-hint--success"] : undefined
            }
          >
            At least 8 characters {pwd.length >= 8 ? "✓" : ""}
          </li>
          <li
            className={
              /[A-Z]/.test(pwd) ? authStyles["auth-hint--success"] : undefined
            }
          >
            1 uppercase letter {/[A-Z]/.test(pwd) ? "✓" : ""}
          </li>
          <li
            className={
              /\d/.test(pwd) ? authStyles["auth-hint--success"] : undefined
            }
          >
            1 number {/\d/.test(pwd) ? "✓" : ""}
          </li>
          <li
            className={
              /[^A-Za-z0-9]/.test(pwd)
                ? authStyles["auth-hint--success"]
                : undefined
            }
          >
            1 special character {/[^A-Za-z0-9]/.test(pwd) ? "✓" : ""}
          </li>
        </ul>
        <button className={authStyles["auth-verify-btn"]}>Reset</button>
      </form>
      {err && <p className={authStyles["auth-hint--error"]}>{err}</p>}
    </div>
  );
}
