/**
 * @fileoverview Text — polymorphic typography primitive with variant styling.
 */

import type { ReactNode } from "react";
import styles from "./Text.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variant = "body" | "muted" | "small" | "mono";
type As = "p" | "span" | "div";

interface Props {
  variant?: Variant;
  as?: As;
  children: ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Typography helper rendering as p, span, or div.
 * @param props.variant - Visual text variant
 * @param props.as - Element tag to render
 * @param props.children - Text content
 * @returns Text element
 * @example <Text variant="muted" as="span">Hint</Text>
 */
export function Text({
  variant = "body",
  as = "p",
  children,
  className,
}: Props) {
  const Tag = as;
  const cls = [styles.text, styles[`text-${variant}`], className]
    .filter(Boolean)
    .join(" ");
  return <Tag className={cls}>{children}</Tag>;
}
