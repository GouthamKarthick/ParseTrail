/**
 * @fileoverview Profile — center avatar with hover edit, names editable only when empty (legacy).
 */

import { useEffect, useRef, useState } from "react";
import { putAvatar, deleteAvatar, updateProfile } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useToastContext } from "../context/ToastContext";
import { Avatar } from "../components/Avatar";
import { processAvatarFile } from "../utils/avatar";
import authStyles from "./Auth.module.scss";

function normalizePhone(v: string): string {
  return v.trim().replace(/[\s\-()]/g, "");
}

/**
 * User profile page.
 */
export default function Profile() {
  const { user, avatar, setAvatarState, refresh } = useAuth();
  const { show } = useToastContext();
  const fileRef = useRef<HTMLInputElement>(null);
  const [firstName, setFirstName] = useState(user?.first_name ?? "");
  const [lastName, setLastName] = useState(user?.last_name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Sync when user loads / refreshes
  useEffect(() => {
    setFirstName(user?.first_name ?? "");
    setLastName(user?.last_name ?? "");
    setPhone(user?.phone ?? "");
  }, [user?.first_name, user?.last_name, user?.phone]);

  const firstEditable = !(user?.first_name || "").trim();
  const lastEditable = !(user?.last_name || "").trim();

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
    // reset input so same file can be re-chosen
    e.target.value = "";
  }

  async function onSave() {
    setErr(null);
    setBusy(true);
    try {
      // Save photo first so it appears even if text fields need fixing.
      if (preview) {
        await putAvatar(preview);
        setAvatarState(preview);
        setPreview(null);
      }
      const payload: {
        phone?: string | null;
        first_name?: string;
        last_name?: string;
      } = {};
      const norm = normalizePhone(phone);
      if (norm && !/^\+[1-9]\d{7,14}$/.test(norm))
        throw new Error("Phone must be E.164 format, e.g. +919876543210");
      payload.phone = norm || null;
      if (firstEditable) {
        if (!firstName.trim()) throw new Error("First name is required");
        payload.first_name = firstName.trim().slice(0, 50);
      }
      if (lastEditable) {
        if (!lastName.trim()) throw new Error("Last name is required");
        payload.last_name = lastName.trim().slice(0, 50);
      }
      if (Object.keys(payload).length > 0) {
        await updateProfile(payload);
      }
      await refresh();
      show("success", "Profile saved");
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      show("warning", msg);
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveAvatar() {
    setBusy(true);
    try {
      await deleteAvatar();
      setAvatarState(null);
      setPreview(null);
      show("success", "Photo removed");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className={authStyles["auth-card"]}>
        <h2>Profile</h2>

        <div className={authStyles["profile-header"]}>
          <div
            className={authStyles["profile-avatar-wrap"]}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
            }}
            role="button"
            tabIndex={0}
            aria-label="Change profile photo"
            title="Change photo"
          >
            <Avatar
              first_name={
                firstEditable && firstName ? firstName : user?.first_name
              }
              last_name={lastEditable && lastName ? lastName : user?.last_name}
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
            Tap the picture to change it.
          </span>
          <span className={authStyles["profile-hint-desktop"]}>
            Click the picture to change it.
          </span>
        </p>

        <label className={authStyles["auth-label"]}>First Name</label>
        <input
          value={firstEditable ? firstName : (user?.first_name ?? "")}
          onChange={(e) => setFirstName(e.target.value)}
          disabled={!firstEditable}
          maxLength={50}
          placeholder="John"
          className={authStyles["auth-input"]}
        />
        <label className={authStyles["auth-label"]}>Last Name</label>
        <input
          value={lastEditable ? lastName : (user?.last_name ?? "")}
          onChange={(e) => setLastName(e.target.value)}
          disabled={!lastEditable}
          maxLength={50}
          placeholder="Doe"
          className={authStyles["auth-input"]}
        />
        <label className={authStyles["auth-label"]}>Email</label>
        <input
          value={user?.email ?? ""}
          disabled
          className={authStyles["auth-input"]}
        />

        <label className={authStyles["auth-label"]}>Phone</label>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+919876543210"
          inputMode="tel"
          className={authStyles["auth-input"]}
        />

        <div className={authStyles["profile-actions"]}>
          <button
            className={authStyles["auth-verify-btn"]}
            onClick={onSave}
            disabled={busy}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {(preview ?? avatar) && (
            <button
              className={authStyles["profile-remove-btn"]}
              onClick={onRemoveAvatar}
              disabled={busy}
              type="button"
            >
              Remove photo
            </button>
          )}
        </div>

        {err && <p className={authStyles["auth-hint--error"]}>{err}</p>}
      </div>
    </div>
  );
}
