/**
 * @fileoverview Toast container — renders transient messages owned by ToastContext.
 */

import styles from "./Toast.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Visual severity for a toast notification. */
export type ToastKind = "success" | "info" | "warning" | "error";

/** Single toast record. */
export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
}

// ---------------------------------------------------------------------------
// Component (state lives in context/ToastContext; this file only renders)
// ---------------------------------------------------------------------------

/**
 * Floating container that renders active toasts.
 * @param props.toasts - Active toast items
 * @param props.onDismiss - Callback to remove a toast
 * @returns Toast container element or null when empty
 * @example <ToastContainer toasts={toasts} onDismiss={dismiss} />
 */
export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className={styles["toast-container"]}>
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          onClick={() => onDismiss(t.id)}
          className={`${styles["toast-item"]} ${styles[`toast-item--${t.kind}`]}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
