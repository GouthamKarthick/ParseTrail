/**
 * @fileoverview Button — themed button primitive with variant and size support.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Styled button composing variant and size CSS modules.
 * @param props.variant - Visual variant
 * @param props.size - Button size
 * @param props.children - Button content
 * @returns Button element
 * @example <Button variant="primary" size="md">Save</Button>
 */
export function Button({
  variant = "primary",
  size = "md",
  children,
  className,
  disabled,
  ...rest
}: Props) {
  const cls = [
    styles.button,
    styles[`button-${variant}`],
    styles[`button-${size}`],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
