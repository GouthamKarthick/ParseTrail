/**
 * @fileoverview Register page — new account creation with password policy validation.
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate password against strength policy.
 * @param pwd - Candidate password
 * @returns Error message or null if valid
 * @example getPasswordError("weak") // "Password must be..."
 */
function getPasswordErrorLocal(pwd: string): string | null {
  if (pwd.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(pwd)) return "Password must contain 1 uppercase letter";
  if (!/\d/.test(pwd)) return "Password must contain 1 number";
  if (!/[^A-Za-z0-9]/.test(pwd))
    return "Password must contain 1 special character";
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Registration page.
 * @returns Register page element
 * @example <Register />
 */
export default function Register() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register } = useAuth();
  const { show } = useToastContext();
  const nav = useNavigate();

  /**
   * Validate inputs and submit registration.
   * @param e - Form submit event
   */
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!firstName.trim() || !lastName.trim()) {
        const msg = "First name and last name are required";
        setErr(msg);
        show("warning", msg);
        return;
      }
      if (
        isSuspiciousFrontend(email) ||
        isSuspiciousFrontend(password) ||
        isSuspiciousFrontend(confirmPassword) ||
        isSuspiciousFrontend(firstName) ||
        isSuspiciousFrontend(lastName)
      ) {
        show("warning", "Suspicious input detected — not saved");
        return;
      }
      const pwErr = getPasswordErrorLocal(password);
      if (pwErr) {
        setErr(pwErr);
        show("warning", pwErr);
        return;
      }
      if (password !== confirmPassword) {
        const msg = "Passwords do not match";
        setErr(msg);
        show("warning", msg);
        return;
      }
      setErr(null);
      setBusy(true);
      try {
        const user = await register(
          firstName.trim(),
          lastName.trim(),
          email,
          password,
        );
        if (user.email_verified) {
          show("success", "Account created. You’re ready to continue.");
          nav("/setup-profile");
        } else {
          if (user.verification_email_sent) {
            show("success", "Registered! Please verify your email.");
          } else {
            show(
              "warning",
              "Account created, but the verification email could not be sent. Try resending the code or contact support.",
            );
          }
          nav(`/verify-email?email=${encodeURIComponent(email)}`);
        }
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes("SUSPICIOUS")) show("warning", msg);
        setErr(msg);
      } finally {
        setBusy(false);
      }
    },
    [
      firstName,
      lastName,
      email,
      password,
      confirmPassword,
      register,
      nav,
      show,
    ],
  );

  return (
    <div className="page">
      <div className={styles["upload-card"]}>
        <Heading level={1}>Create account</Heading>
        <Text variant="muted">
          Start organizing your invoices with ClarityDocs.
        </Text>

        <form onSubmit={handleSubmit} className={styles["upload-form"]}>
          <div className={authStyles["auth-field"]}>
            <label
              htmlFor="register-first"
              className={authStyles["auth-label"]}
            >
              First Name
            </label>
            <div className={authStyles["auth-input-wrap"]}>
              <Input
                id="register-first"
                type="text"
                placeholder="John"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                maxLength={50}
                autoComplete="given-name"
              />
            </div>
          </div>
          <div className={authStyles["auth-field"]}>
            <label htmlFor="register-last" className={authStyles["auth-label"]}>
              Last Name
            </label>
            <div className={authStyles["auth-input-wrap"]}>
              <Input
                id="register-last"
                type="text"
                placeholder="Doe"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                maxLength={50}
                autoComplete="family-name"
              />
            </div>
          </div>
          <div className={authStyles["auth-field"]}>
            <label
              htmlFor="register-email"
              className={authStyles["auth-label"]}
            >
              Email
            </label>
            <div className={authStyles["auth-input-wrap"]}>
              <Input
                id="register-email"
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
              htmlFor="register-password"
              className={authStyles["auth-label"]}
            >
              Password
            </label>
            <div className={authStyles["auth-input-wrap"]}>
              <Input
                id="register-password"
                type={showPassword ? "text" : "password"}
                placeholder="8+ chars, 1 uppercase, 1 number, 1 special"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
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
            <ul className={authStyles["auth-list"]}>
              <li
                className={
                  password.length >= 8
                    ? authStyles["auth-hint--success"]
                    : undefined
                }
              >
                At least 8 characters {password.length >= 8 ? "✓" : ""}
              </li>
              <li
                className={
                  /[A-Z]/.test(password)
                    ? authStyles["auth-hint--success"]
                    : undefined
                }
              >
                1 uppercase letter {/[A-Z]/.test(password) ? "✓" : ""}
              </li>
              <li
                className={
                  /\d/.test(password)
                    ? authStyles["auth-hint--success"]
                    : undefined
                }
              >
                1 number {/\d/.test(password) ? "✓" : ""}
              </li>
              <li
                className={
                  /[^A-Za-z0-9]/.test(password)
                    ? authStyles["auth-hint--success"]
                    : undefined
                }
              >
                1 special character {/[^A-Za-z0-9]/.test(password) ? "✓" : ""}
              </li>
            </ul>
          </div>

          <div className={authStyles["auth-field"]}>
            <label
              htmlFor="register-confirm"
              className={authStyles["auth-label"]}
            >
              Confirm Password
            </label>
            <div className={authStyles["auth-input-wrap"]}>
              <Input
                id="register-confirm"
                type={showConfirm ? "text" : "password"}
                placeholder="Re-enter password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className={[
                  authStyles["auth-input--with-icon"],
                  confirmPassword && password !== confirmPassword
                    ? authStyles["auth-input--error"]
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              <button
                type="button"
                aria-label={showConfirm ? "Hide password" : "Show password"}
                title={showConfirm ? "Hide password" : "Show password"}
                onClick={() => setShowConfirm((v) => !v)}
                className={authStyles["auth-toggle"]}
              >
                <i
                  className={showConfirm ? "bi bi-eye-slash" : "bi bi-eye"}
                  aria-hidden
                />
              </button>
            </div>
            {confirmPassword && password !== confirmPassword && (
              <span className={authStyles["auth-hint--error"]}>
                Passwords do not match
              </span>
            )}
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
                <i className="bi bi-arrow-repeat" aria-hidden /> Creating…
              </>
            ) : (
              <>
                <i className="bi bi-person-plus" aria-hidden /> Register
              </>
            )}
          </Button>

          <div className={authStyles["auth-center"]}>
            <Text variant="small">
              Already have an account?{" "}
              <Link to="/login" className={authStyles["auth-link"]}>
                Login
              </Link>
            </Text>
          </div>
        </form>
      </div>
    </div>
  );
}
