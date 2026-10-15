/**
 * @fileoverview FormattedDate — localized date + time display with inline variant.
 */

import styles from "./FormattedDate.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  iso: string;
  className?: string;
  inline?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Render an ISO date string as localized date and time spans.
 * @param props.iso - ISO 8601 date string
 * @param props.className - Additional CSS class
 * @param props.inline - Whether to render date and time inline
 * @returns Span element with formatted date
 * @example <FormattedDate iso={doc.created_at} inline />
 */
export function FormattedDate({ iso, className, inline = false }: Props) {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeStr = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const variant = inline ? styles["formatted-date--inline"] : undefined;

  return (
    <span
      className={[styles["formatted-date"], variant, className]
        .filter(Boolean)
        .join(" ")}
      title={d.toLocaleString()}
    >
      <span className={styles["formatted-date-date"]}>
        {dateStr}
        {inline ? "," : ""}
      </span>
      <span className={styles["formatted-date-time"]}>{timeStr}</span>
    </span>
  );
}
