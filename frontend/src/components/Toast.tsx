/**
 * @fileoverview Toast container — renders transient messages owned by ToastContext.
 */

import styles from './Toast.module.scss';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Visual severity for a toast notification. */
export type ToastKind = 'success' | 'info' | 'warning' | 'error';

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
 * @param props.pausedId - Id of the toast currently hovered (auto-dismiss paused)
 * @param props.onDismiss - Callback to remove a toast
 * @param props.onMouseEnter - Callback when a toast is hovered
 * @param props.onMouseLeave - Callback when a toast is unhovered
 * @returns Toast container element or null when empty
 * @example <ToastContainer toasts={toasts} onDismiss={dismiss} />
 */
export function ToastContainer({
  toasts,
  pausedId,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}: {
  toasts: ToastItem[];
  pausedId: string | null;
  onDismiss: (id: string) => void;
  onMouseEnter: (id: string) => void;
  onMouseLeave: () => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className={styles['toast-container']}>
      {toasts.map(t => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          onClick={() => onDismiss(t.id)}
          onMouseEnter={() => onMouseEnter(t.id)}
          onMouseLeave={onMouseLeave}
          className={`${styles['toast-item']} ${styles[`toast-item--${t.kind}`]}${
            pausedId === t.id ? ` ${styles['toast-item--paused']}` : ''
          }`}
        >
          {t.message}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={e => {
              e.stopPropagation();
              onDismiss(t.id);
            }}
            className={styles['toast-dismiss']}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
