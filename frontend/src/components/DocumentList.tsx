/**
 * @fileoverview DocumentList — handles loading / empty states and grid vs list rendering.
 */

import type { Document } from "../types";
import { DocumentRow } from "./DocumentRow";
import { Skeleton } from "./Skeleton";
import { EmptyState } from "./Feedback";
import styles from "./DocumentList.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported visual layout modes. */
export type ViewMode = "list" | "grid";

interface Props {
  documents: Document[];
  view: ViewMode;
  loading?: boolean;
  hasFilters?: boolean;
  filterLabel?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Render a collection of documents with loading and empty handling.
 * @param props.documents - Documents to display
 * @param props.view - Layout mode (list or grid)
 * @param props.loading - Whether data is still loading
 * @param props.hasFilters - Whether filters are active
 * @param props.filterLabel - Active filter label for empty message
 * @returns Document list element
 * @example <DocumentList documents={docs} view="grid" />
 */
export function DocumentList({
  documents,
  view,
  loading,
  hasFilters,
  filterLabel,
}: Props) {
  if (loading && documents.length === 0) {
    return (
      <div className={styles["document-list-skeleton"]}>
        <Skeleton lines={5} />
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className={styles["document-list-empty"]}>
        {hasFilters ? (
          <EmptyState
            icon="search"
            title="No matches"
            message={`No documents matching "${filterLabel}".`}
          />
        ) : (
          <EmptyState
            icon="cloud-arrow-up"
            title="No documents yet"
            message="Upload your first invoice or receipt to get started."
            actionTo="/"
            actionLabel="Upload a document"
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <div
        className={
          view === "grid"
            ? styles["document-list-grid"]
            : styles["document-list-list"]
        }
      >
        {documents.map((d) => (
          <DocumentRow key={d.id} doc={d} />
        ))}
      </div>
    </div>
  );
}
