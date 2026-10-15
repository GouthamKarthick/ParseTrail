/**
 * @fileoverview Upload page — file selection, suspicious-name guard, and document upload flow.
 */

import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { uploadDocument, ApiError } from "../api/client";
import { useToastContext, kindFromStatus } from "../context/ToastContext";
import { isSuspiciousFrontend } from "../utils/security";
import { Button } from "../components/ui/Button";
import { Heading } from "../components/ui/Heading";
import { Text } from "../components/ui/Text";
import styles from "./Upload.module.scss";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Document upload page.
 * @returns Upload page element
 * @example <Upload />
 */
export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const { show } = useToastContext();
  const nav = useNavigate();

  /**
   * Handle native file input change with frontend security check.
   * @param e - Input change event
   */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0] ?? null;
      if (f && isSuspiciousFrontend(f.name)) {
        show("warning", "Suspicious file name detected — not saved");
        e.target.value = "";
        return;
      }
      setFile(f);
    },
    [show],
  );

  /**
   * Submit selected file to backend.
   * @param e - Form submit event
   */
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (isSuspiciousFrontend(file.name)) {
      show("warning", "Suspicious file name detected — not saved");
      return;
    }
    setBusy(true);
    try {
      const res = await uploadDocument(file);
      show("success", `Uploaded ${res.name} — ${res.status}`);
      nav(`/documents/${res.id}`);
    } catch (e) {
      const err = e as ApiError;
      if (
        err.status === 409 &&
        (err.code === "DUPLICATE_CONTENT" || err.code === "DUPLICATE_UPDATED")
      ) {
        show(
          "warning",
          `Duplicate document — updated existing record (id ${err.duplicateOf ?? ""}). Not added as new.`,
        );
        if (err.duplicateOf) nav(`/documents/${err.duplicateOf}`);
      } else if (err.code === "SUSPICIOUS_INPUT") {
        show("warning", err.message || "Suspicious input detected — not saved");
      } else {
        const kind = err.status ? kindFromStatus(err.status) : "error";
        show(kind, err.message || "Upload failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className={styles["upload-card"]}>
        <Heading level={1}>Upload document</Heading>
        <Text variant="muted">
          PDF, PNG, JPG — max 10MB. Scanned images are OCR&apos;d automatically.
        </Text>

        <form onSubmit={onSubmit} className={styles["upload-form"]}>
          <label className={styles["upload-dropzone"]}>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={handleFileChange}
              className={styles["upload-file-input"]}
            />
            <span className={styles["upload-drop-text"]}>
              {file ? file.name : "Drop file here or click to browse"}
            </span>
            <span className={styles["upload-drop-hint"]}>
              Supported: .pdf .png .jpg .jpeg
            </span>
          </label>

          <div className={styles["upload-actions"]}>
            <Button
              type="submit"
              disabled={!file || busy}
              variant="primary"
              size="md"
            >
              {busy ? "Uploading..." : "Upload"}
            </Button>
            {file && (
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => setFile(null)}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
