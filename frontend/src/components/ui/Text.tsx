/**
 * @fileoverview Text — unified typography primitive.
 * Merges the former Text and Heading components into one.
 * Renders as p | span | div | h1 | h2 | h3 with variant and optional muted suffix.
 */

import type { ReactNode } from 'react';
import styles from './Text.module.scss';

type Variant = 'body' | 'muted' | 'small' | 'mono';
type As = 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3';

interface Props {
  /** Heading level (1-3). When set, overrides `as` to the matching h tag. No default. */
  level?: 1 | 2 | 3;
  /** Visual text variant. Default: 'body'. */
  variant?: Variant;
  /** Element tag to render. Ignored when `level` is set. Default: 'p'. */
  as?: As;
  /** Optional muted suffix text rendered as a trailing span. */
  muted?: string;
  /** Children content. */
  children: ReactNode;
  /** Additional CSS class. */
  className?: string;
}

/**
 * Unified typography helper rendering as p, span, div, h1, h2, or h3.
 * @param props.level - Heading level (1-3). When set, overrides `as` to hN; no default.
 * @param props.variant - Visual text variant (body, muted, small, mono)
 * @param props.as - Element tag to render (used only when level is not set)
 * @param props.muted - Optional muted suffix text
 * @param props.children - Text content
 * @param props.className - Additional CSS class
 * @returns Text element
 * @example <Text variant="body">Hello</Text>
 * @example <Text level={1} muted="3 total">Documents</Text>
 * @example <Text as="h2" variant="small">Section</Text>
 */
export function Text({ level, variant = 'body', as: asProp, muted, children, className }: Props) {
  const Tag = level ? (`h${level}` as 'h1' | 'h2' | 'h3') : (asProp ?? 'p');
  const cls = [styles.text, level ? styles[`text-h${level}`] : styles[`text-${variant}`], className]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={cls}>
      {children}
      {muted && <span className={styles['text-muted-suffix']}>{muted}</span>}
    </Tag>
  );
}
