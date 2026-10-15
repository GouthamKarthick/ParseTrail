/**
 * @fileoverview ForgotPassword page — request password reset email.
 */

import { useState } from "react";
import { forgotPassword } from "../api/client";
import authStyles from "./Auth.module.scss";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Form to request a password reset link.
 * @returns ForgotPassword page element
 * @example <ForgotPassword />
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  /**
   * Submit email to trigger reset flow.
   * @param e - Form submit event
   */
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await forgotPassword(email);
    setMsg("If email exists, reset link sent (Resend free)");
  }

  return (
    <div className={authStyles["auth-card"]}>
      <h2>Forgot Password</h2>
      <form onSubmit={onSubmit} className={authStyles["auth-field"]}>
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={authStyles["auth-input"]}
        />
        <button className={authStyles["auth-verify-btn"]}>Send reset</button>
      </form>
      {msg && <p className={authStyles["auth-hint--success"]}>{msg}</p>}
    </div>
  );
}
