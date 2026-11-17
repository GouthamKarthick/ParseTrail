/**
 * @fileoverview TextBlock — unified typography primitive.
 * Renders as p | span | div | h1 | h2 | h3 with text style and optional muted suffix.
 */

import type { ReactNode } from 'react';
import styles from './Text.module.scss';

type TextStyle = 'body' | 'muted' | 'small' | 'mono';
type HtmlTag = 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3';

interface Props {
  /** Heading level (1-3). When set, overrides htmlTag to the matching h tag. No default. */
  headingLevel?: 1 | 2 | 3;
  /** Visual text style. Default: 'body'. */
  textStyle?: TextStyle;
  /** Element tag to render. Ignored when headingLevel is set. Default: 'p'. */
  htmlTag?: HtmlTag;
  /** Optional muted suffix text rendered as a trailing span. */
  mutedText?: string;
  /** Text content to display. */
  children: ReactNode;
  /** Additional CSS class. */
  extraClass?: string;
}

/**
 * Unified typography helper rendering as p, span, div, h1, h2, or h3.
 * @param props.headingLevel - Heading level (1-3). When set, overrides htmlTag to hN; no default.
 * @param props.textStyle - Visual text style (body, muted, small, mono)
 * @param props.htmlTag - Element tag to render (used only when headingLevel is not set)
 * @param props.mutedText - Optional muted suffix text
 * @param props.children - Text content to display
 * @param props.extraClass - Additional CSS class
 * @returns Text element
 * @example <TextBlock textStyle="body">Hello</TextBlock>
 * @example <TextBlock headingLevel={1} mutedText="3 total">Documents</TextBlock>
 * @example <TextBlock htmlTag="h2" textStyle="small">Section</TextBlock>
 */
export function TextBlock({
  headingLevel,
  textStyle = 'body',
  htmlTag: htmlTagProp,
  mutedText,
  children,
  extraClass,
}: Props) {
  const HtmlTag = headingLevel ? (`h${headingLevel}` as 'h1' | 'h2' | 'h3') : (htmlTagProp ?? 'p');
  const cssClasses = [
    styles.text,
    headingLevel ? styles[`text-h${headingLevel}`] : styles[`text-${textStyle}`],
    extraClass,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <HtmlTag className={cssClasses}>
      {children}
      {mutedText && <span className={styles['text-muted-suffix']}>{mutedText}</span>}
    </HtmlTag>
  );
}
