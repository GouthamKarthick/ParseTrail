/**
 * @fileoverview Heading — semantic h1-h3 with optional muted suffix.
 */

import type { ReactNode } from "react";
import styles from "./Heading.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Level = 1 | 2 | 3;

interface Props {
  level?: Level;
  children: ReactNode;
  muted?: string; // optional subtitle / count
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Section heading at specified level.
 * @param props.level - Heading level (1-3)
 * @param props.children - Heading content
 * @param props.muted - Optional muted suffix text
 * @returns Heading element
 * @example <Heading level={1} muted="3 total">Documents</Heading>
 */
export function Heading({ level = 2, children, muted, className }: Props) {
  const Tag = `h${level}` as "h1" | "h2" | "h3";
  const cls = [styles.heading, styles[`heading-h${level}`], className]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={cls}>
      {children}
      {muted && <span className={styles["heading-muted"]}>{muted}</span>}
    </Tag>
  );
}
