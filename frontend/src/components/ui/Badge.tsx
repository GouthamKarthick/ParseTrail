/**
 * @fileoverview Badge — compact label for status and type annotations.
 */

import type { ReactNode } from "react";
import styles from "./Badge.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variant = "neutral" | "info" | "success" | "warning" | "error" | "type";

interface Props {
  variant?: Variant;
  children: ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Inline badge with variant styling.
 * @param props.variant - Color variant
 * @param props.children - Badge text
 * @param props.className - Optional extra class
 * @returns Span element
 * @example <Badge variant="success">done</Badge>
 */
export function Badge({ variant = "neutral", children, className }: Props) {
  const cls = [styles.badge, styles[`badge-${variant}`], className]
    .filter(Boolean)
    .join(" ");
    
  return <span className={cls}>{children}</span>;
}
