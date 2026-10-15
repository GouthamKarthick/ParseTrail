/**
 * @fileoverview List page — searchable, filterable document table with list/grid view toggle.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { listDocuments, ApiError } from "../api/client";
import type { Document } from "../types";
import { useToastContext, kindFromStatus } from "../context/ToastContext";
import { isSuspiciousFrontend } from "../utils/security";
import { Heading } from "../components/ui/Heading";
import { Input } from "../components/ui/Input";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/Feedback";
import { statusBadges } from "../utils/badges";
import { formatMoney } from "../utils/format";
import { FilterDropdown } from "../components/FilterDropdown";
import { DocumentList, type ViewMode } from "../components/DocumentList";
import styles from "./List.module.scss";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_TYPES: { value: string; label: string }[] = [
  { value: "", label: "All types" },
  { value: "invoice", label: "Invoice" },
  { value: "receipt", label: "Receipt" },
  { value: "payment", label: "Payment" },
  { value: "bill", label: "Bill" },
  { value: "payslip", label: "Payslip" },
  { value: "settlement_slip", label: "Settlement Slip" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Unknown" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Document list page with URL-synced search and type filter.
 * @returns List page element
 * @example <List />
 */
export default function List() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const { show } = useToastContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const qParam = searchParams.get("q") ?? "";
  const typeParam = searchParams.get("type") ?? "";
  const [qInput, setQInput] = useState(qParam);
  const [debouncedQ, setDebouncedQ] = useState(qParam);

  const typeValues = useMemo(
    () => DOC_TYPES.map((o) => o.value).filter(Boolean),
    [],
  );
  const selectedTypes = useMemo(
    () =>
      typeParam
        .split(",")
        .map((s) => s.trim())
        .filter((v) => typeValues.includes(v)),
    [typeParam, typeValues],
  );
  const selectedLabels = useMemo(
    () =>
      selectedTypes.map(
        (v) => DOC_TYPES.find((o) => o.value === v)?.label ?? v,
      ),
    [selectedTypes],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      if (isSuspiciousFrontend(qInput)) {
        show("warning", "Suspicious search input — not saved");
        return;
      }
      setDebouncedQ(qInput.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, show]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (debouncedQ) next.set("q", debouncedQ);
    else next.delete("q");
    if (next.toString() !== searchParams.toString())
      setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  useEffect(() => {
    setQInput(qParam);
  }, [qParam]);

  useEffect(() => {
    setLoading(true);
    const opts: { q?: string; document_type?: string } = {};
    if (qParam) opts.q = qParam;
    if (selectedTypes.length) opts.document_type = selectedTypes.join(",");
    listDocuments(20, 0, opts)
      .then((r) => {
        setDocs(r.documents);
        setTotal(r.total);
      })
      .catch((e) => {
        const err = e as ApiError | Error;
        const status = (err as ApiError).status ?? 500;
        const kind = kindFromStatus(status);
        show(kind, err.message || "Failed to list documents");
      })
      .finally(() => setLoading(false));
  }, [qParam, typeParam, show]);

  const toggleType = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams);
      const current = new Set(selectedTypes);
      if (current.has(value)) current.delete(value);
      else current.add(value);
      const ordered = typeValues.filter((v) => current.has(v));
      if (ordered.length) next.set("type", ordered.join(","));
      else next.delete("type");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams, selectedTypes, typeValues],
  );

  const handleViewList = useCallback(() => setView("list"), []);

  const handleViewGrid = useCallback(() => setView("grid"), []);

  const handleQChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setQInput(e.target.value),
    [],
  );

  const [view, setView] = useState<ViewMode>("list");

  const hasFilters = Boolean(qParam || selectedTypes.length);

  return (
    <div className="page">
      <div className={styles["list-header"]}>
        <Heading level={1} muted={`${total} total`}>
          Documents
        </Heading>
        <div
          className={styles["list-view-toggle"]}
          role="tablist"
          aria-label="View mode"
        >
          <button
            role="tab"
            aria-selected={view === "list"}
            className={
              view === "list"
                ? styles["list-toggle--active"]
                : styles["list-toggle"]
            }
            onClick={handleViewList}
            type="button"
          >
            <i className="bi bi-list-ul" aria-hidden /> List
          </button>
          <button
            role="tab"
            aria-selected={view === "grid"}
            className={
              view === "grid"
                ? styles["list-toggle--active"]
                : styles["list-toggle"]
            }
            onClick={handleViewGrid}
            type="button"
          >
            <i className="bi bi-grid-fill" aria-hidden /> Grid
          </button>
        </div>
      </div>

      <div className={styles["list-filters"]}>
        <Input
          aria-label="Search by document name"
          placeholder="Search by name..."
          value={qInput}
          onChange={handleQChange}
        />
        <FilterDropdown
          options={DOC_TYPES.filter((o) => o.value !== "")}
          selected={selectedTypes}
          active={hasFilters}
          onToggle={toggleType}
        />
      </div>

      {view === "list" ? (
        <div className={styles["list-table-wrap"]} aria-busy={loading}>
          {docs.length === 0 ? (
            loading ? (
              <Skeleton lines={6} />
            ) : hasFilters ? (
              <EmptyState
                icon="search"
                title="No matches"
                message={`No documents matching "${qParam || selectedLabels.join(", ")}".`}
              />
            ) : (
              <EmptyState
                icon="cloud-arrow-up"
                title="No documents yet"
                message="Upload your first invoice or receipt to get started."
                actionTo="/"
                actionLabel="Upload a document"
              />
            )
          ) : (
            <>
              <table className={styles["list-table"]}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Amount</th>
                    <th>Currency</th>
                    <th>Date</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr
                      key={d.id}
                      className={styles["list-row"]}
                      tabIndex={0}
                      role="link"
                      aria-label={`Open ${d.name}`}
                      onClick={() => navigate(`/documents/${d.id}`)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          navigate(`/documents/${d.id}`);
                        }
                      }}
                    >
                      <td>
                        <span className={styles["list-document-name"]}>
                          {d.name}
                        </span>
                      </td>
                      <td>
                        <span className={styles["list-type"]}>
                          {d.document_type}
                        </span>
                      </td>
                      <td>
                        <span className={styles["list-statuses"]}>
                          {statusBadges(d.status, d.refine_status).map((b, i) => (
                            <span
                              key={i}
                              className={`${styles["list-status"]} ${styles[`list-status-${b.variant}`]}`}
                            >
                              {b.label}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>
                        {formatMoney(
                          typeof d.data?.totalAmount === "number"
                            ? d.data.totalAmount
                            : Number(d.data?.totalAmount),
                          d.data?.currency,
                        )}
                      </td>
                      <td>{d.data?.currency ?? "—"}</td>
                      <td>{d.data?.invoiceDate ?? "—"}</td>
                      <td>{new Date(d.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {loading && <Skeleton lines={2} />}
            </>
          )}
        </div>
      ) : (
        <DocumentList
          documents={docs}
          view={view}
          loading={loading}
          hasFilters={hasFilters}
          filterLabel={qParam || selectedLabels.join(", ")}
        />
      )}
    </div>
  );
}
