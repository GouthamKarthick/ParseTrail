/**
 * @fileoverview ConfirmDialog — accessible modal confirmation built on native <dialog>.
 * Uses showModal() so the page behind is inert, focus is trapped, and Escape cancels.
 */

import { useEffect, useRef, type ReactNode } from 'react';

interface ConfirmDialogProps {
  /** Class applied to the <dialog> overlay. */
  dialogClassName: string;
  /** Called when the user cancels (Escape, backdrop click, or Cancel button). */
  onCancel: () => void;
  /** Dialog content, including its own action buttons. */
  children: ReactNode;
  /** Accessible label for the dialog. */
  label: string;
}

/**
 * Modal confirmation dialog. Render it only while it should be open.
 * @param props - Dialog props
 * @returns Dialog element
 * @example <ConfirmDialog label="Delete document" dialogClassName={s.dlg} onCancel={close}>...</ConfirmDialog>
 */
export function ConfirmDialog({ dialogClassName, onCancel, children, label }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom (tests) has no showModal; fall back to the open attribute.
    if (typeof el.showModal === 'function') {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute('open', '');
    }
    return () => {
      if (typeof el.close === 'function' && el.open) el.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={dialogClassName}
      onCancel={e => {
        e.preventDefault();
        onCancel();
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {children}
    </dialog>
  );
}
