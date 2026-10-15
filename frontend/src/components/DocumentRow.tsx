/**
 * @fileoverview DocumentRow — memoized link row displaying name, type badge, status, and date.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import type { Document } from "../types";
import { FormattedDate } from "./FormattedDate";
import { statusBadges } from "../utils/badges";
import styles from "./DocumentRow.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  doc: Document;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Single document row linking to detail view.
 * @param props.doc - Document to render
 * @returns Link element with badges and formatted date
 * @example <DocumentRow doc={doc} />
 */
export const DocumentRow = memo(function DocumentRow({ doc }: Props) {
  return (
    <Link
      to={`/documents/${doc.id}`}
      className={styles["document-row"]}
      aria-label={`Open ${doc.name}`}
    >
      <div className={styles["document-row-main"]}>
        <span className={styles["document-row-name"]} title={doc.name}>
          {doc.name}
        </span>
        <span className={styles["document-row-meta"]}>
          <span className={`${styles["document-row-status"]} ${styles["document-row-type"]}`}>
            {doc.document_type}
          </span>
          {statusBadges(doc.status, doc.refine_status).map((b, i) => (
            <span
              key={i}
              className={`${styles["document-row-status"]} ${styles[`document-row-status-${b.variant}`]}`}
            >
              {b.label}
            </span>
          ))}
        </span>
      </div>
      <div className={styles["document-row-date-col"]}>
        <FormattedDate iso={doc.created_at} />
      </div>
      <span className={styles["document-row-chevron"]} aria-hidden>
        <i className="bi bi-chevron-right" aria-hidden />
      </span>
    </Link>
  );
});
