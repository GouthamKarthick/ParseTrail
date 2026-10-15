/**
 * @fileoverview Toast primitives — standalone hook and container for transient messages.
 */

import { useState } from "react";
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
// Hooks
// ---------------------------------------------------------------------------

/**
 * Local toast state for isolated component usage.
 * @returns Toast list plus show/dismiss helpers
 * @example const { toasts, show } = useToast();
 */
export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = (kind: ToastKind, message: string) => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  };

  return {
    toasts,
    show,
    dismiss: (id: string) => setToasts((t) => t.filter((x) => x.id !== id)),
  };
}

// ---------------------------------------------------------------------------
// Component
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
