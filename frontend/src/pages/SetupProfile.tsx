/**
 * @fileoverview SetupProfile — optional phone + avatar onboarding after mandatory verification.
 */

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { putAvatar, updateProfile } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useToastContext } from "../context/ToastContext";
import { Avatar } from "../components/Avatar";
import { processAvatarFile } from "../utils/avatar";
import { normalizePhone } from "../utils/format";
import authStyles from "./Auth.module.scss";

/** Normalize phone: strip spaces/dashes/parens. */
/**
 * Optional profile setup with Skip.
 */
export default function SetupProfile() {
  const { user, avatar, setAvatarState, refresh } = useAuth();
  const { show } = useToastContext();
  const nav = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [phone, setPhone] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    try {
      setErr(null);
      // Compresses large phone photos to ≤1MB automatically.
      const url = await processAvatarFile(f);
      setPreview(url);
    } catch (err) {
      setErr((err as Error).message);
    }
    e.target.value = "";
  }

  async function onSave() {
    setErr(null);
    setBusy(true);
    try {
      // Save photo first so it appears even if the phone number needs fixing.
      if (preview) {
        await putAvatar(preview);
        setAvatarState(preview);
      }
      
      if (phone.trim()) {
        const norm = normalizePhone(phone);

        if (!/^\+[1-9]\d{7,14}$/.test(norm))
          throw new Error("Phone must be E.164 format, e.g. +919876543210");

        await updateProfile({ phone: norm });
      }

      await refresh();
      show("success", "Profile setup saved");
      nav("/");
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      show("warning", msg);
    } finally {
      setBusy(false);
    }
  }

  function onSkip() {
    nav("/");
  }

  return (
    <div className="page">
      <div className={authStyles["auth-card"]}>
        <h2>Setup your profile (optional)</h2>
        <p className={authStyles["auth-hint"]}>
          Add a photo and phone number, or skip for now. You can edit them later
          in Profile.
        </p>
        <div className={authStyles["profile-header"]}>
          <div
            className={authStyles["profile-avatar-wrap"]}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
            }}
            role="button"
            tabIndex={0}
            aria-label="Upload profile photo"
            title="Upload photo"
          >
            <Avatar
              first_name={user?.first_name}
              last_name={user?.last_name}
              email={user?.email}
              src={preview ?? avatar}
              size={104}
            />
            <span className={authStyles["profile-avatar-overlay"]} aria-hidden>
              <i className="bi bi-pencil" aria-hidden />
            </span>
          </div>
          <p className={authStyles["profile-email"]}>{user?.email ?? ""}</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onFile}
          aria-label="Upload profile photo"
          className={authStyles["profile-file-input"]}
        />
        <p className={authStyles["auth-hint"]}>
          <span className={authStyles["profile-hint-touch"]}>
            Tap the picture to choose a photo.
          </span>
          <span className={authStyles["profile-hint-desktop"]}>
            Click the picture to choose a photo.
          </span>
        </p>
        <label className={authStyles["auth-label"]}>Phone</label>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+919876543210"
          inputMode="tel"
          className={authStyles["auth-input"]}
        />
        {err && <p className={authStyles["auth-hint--error"]}>{err}</p>}
        <div className={authStyles["profile-actions"]}>
          <button
            className={authStyles["auth-verify-btn"]}
            onClick={onSave}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save & Continue"}
          </button>
          <button
            className={authStyles["profile-remove-btn"]}
            onClick={onSkip}
            type="button"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
