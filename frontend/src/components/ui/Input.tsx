/**
 * @fileoverview Input — styled native input wrapper for consistent theming.
 */

import type { InputHTMLAttributes } from "react";
import styles from "./Input.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props extends InputHTMLAttributes<HTMLInputElement> {}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Themed input forwarding all native props.
 * @param props - Native input attributes
 * @returns Input element
 * @example <Input placeholder="Email" type="email" />
 */
export function Input({ className, ...rest }: Props) {
  const cls = [styles.input, className].filter(Boolean).join(" ");
  return <input className={cls} {...rest} />;
}
