/**
 * @fileoverview Toast notification context — global show/dismiss API with auto-expire.
 * Renders a portal-like container via ToastContainer.
 */

import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ToastContainer,
  type ToastKind,
  type ToastItem,
} from "../components/Toast";

// ---------------------------------------------------------------------------
// Types & Context
// ---------------------------------------------------------------------------

type ToastContextValue = { show: (kind: ToastKind, message: string) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

// ---------------------------------------------------------------------------
// Hooks & Helpers
// ---------------------------------------------------------------------------

/**
 * Consume toast context to display notifications.
 * @returns Toast context value with show method
 * @throws When used outside ToastProvider
 * @example const { show } = useToastContext(); show("success", "Saved!");
 */
export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx)
    throw new Error("useToastContext must be used within ToastProvider");
  return ctx;
}

/**
 * Map HTTP status code to a toast kind for consistent UX feedback.
 * @param status - HTTP status code
 * @returns Toast kind matching the status range
 * @example kindFromStatus(404) // "warning"
 */
export function kindFromStatus(status: number): ToastKind {
  if (status >= 500) return "error";
  if (status >= 400) return "warning";
  if (status >= 200) return "success";
  return "error";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provides toast state and renders the floating container.
 * @param children - App subtree
 * @returns Provider wrapping children plus toast container
 * @example <ToastProvider><App /></ToastProvider>
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((kind: ToastKind, message: string) => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }, []);

  const dismiss = useCallback(
    (id: string) => setToasts((t) => t.filter((x) => x.id !== id)),
    [],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
