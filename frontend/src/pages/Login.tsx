/**
 * @fileoverview Login page — credential form with visibility toggle and toast feedback.
 */

import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { isSuspiciousFrontend } from "../utils/security";
import { useToastContext } from "../context/ToastContext";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Heading } from "../components/ui/Heading";
import { Text } from "../components/ui/Text";
import styles from "./Upload.module.scss";
import authStyles from "./Auth.module.scss";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Login page for existing users.
 * @returns Login page element
 * @example <Login />
 */
export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const { show } = useToastContext();
  const nav = useNavigate();

  /**
   * Submit login credentials.
   * @param e - Form submit event
   */
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (isSuspiciousFrontend(email) || isSuspiciousFrontend(password)) {
        show("warning", "Suspicious input detected — not saved");
        return;
      }
      setErr(null);
      setBusy(true);
      try {
        await login(email, password);
        nav("/");
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes("SUSPICIOUS")) show("warning", msg);
        setErr(msg);
      } finally {
        setBusy(false);
      }
    },
    [email, password, login, nav, show],
  );

  return (
    <div className="page">
      <div className={styles["upload-card"]}>
        <Heading level={1}>Welcome back</Heading>
        <Text variant="muted">Sign in to continue to ClarityDocs.</Text>

        <form onSubmit={handleSubmit} className={styles["upload-form"]}>
          <div className={authStyles["auth-field"]}>
            <label htmlFor="login-email" className={authStyles["auth-label"]}>
              Email
            </label>
            <div className={authStyles["auth-input-wrap"]}>
              <Input
                id="login-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className={authStyles["auth-input--with-icon"]}
              />
              <span aria-hidden className={authStyles["auth-icon"]}>
                <i className="bi bi-envelope" aria-hidden />
              </span>
            </div>
          </div>

          <div className={authStyles["auth-field"]}>
            <label
              htmlFor="login-password"
              className={authStyles["auth-label"]}
            >
              Password
            </label>
            <div className={authStyles["auth-input-wrap"]}>
              <Input
                id="login-password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className={authStyles["auth-input--with-icon"]}
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
                className={authStyles["auth-toggle"]}
              >
                <i
                  className={showPassword ? "bi bi-eye-slash" : "bi bi-eye"}
                  aria-hidden
                />
              </button>
            </div>
          </div>

          {err && <div className={authStyles["auth-error"]}>{err}</div>}

          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={busy}
            className={authStyles["auth-submit"]}
          >
            {busy ? (
              <>
                <i className="bi bi-arrow-repeat" aria-hidden /> Signing in…
              </>
            ) : (
              <>
                <i
                  className={`bi bi-box-arrow-in-right ${authStyles["auth-strong-icon"]}`}
                  aria-hidden
                />{" "}
                Login
              </>
            )}
          </Button>

          <div
            className={`${authStyles["auth-actions"]} ${authStyles["auth-actions--between"]}`}
          >
            <Link to="/register" className={authStyles["auth-link"]}>
              Create account
            </Link>
            <Link
              to="/forgot-password"
              className={authStyles["auth-muted-link"]}
            >
              Forgot password?
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
