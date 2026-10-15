/**
 * @fileoverview Detail page — polls document status and displays extracted data.
 */

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { usePolling } from "../hooks/usePolling";
import { useToastContext } from "../context/ToastContext";
import {
  retryDocumentRefinement as retryDocumentRefinementRequest,
  getAttempts,
  submitCorrection,
  listCorrections,
} from "../api/client";
import type { ExtractionAttempt, Correction } from "../types";
import { Heading } from "../components/ui/Heading";
import { Text } from "../components/ui/Text";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EmptyState, ErrorState } from "../components/Feedback";
import { statusBadges } from "../utils/badges";
import { FormattedDate } from "../components/FormattedDate";
import styles from "./Detail.module.scss";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Document detail page for a given id.
 * @returns Detail page element
 * @example <Detail />
 */
const CORRECTABLE = [
  "vendor",
  "invoiceNumber",
  "invoiceDate",
  "totalAmount",
  "currency",
];

export default function Detail() {
  const { id } = useParams<{ id: string }>();
  const { doc, error, refresh } = usePolling(id ?? null, 2000);
  const { show } = useToastContext();
  const [retrying, setRetrying] = useState(false);
  const [attempts, setAttempts] = useState<ExtractionAttempt[]>([]);
  const [history, setHistory] = useState<Correction[]>([]);
  const [editing, setEditing] = useState<{
    field: string;
    draft: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const latestLlmAttempt = [...attempts]
    .reverse()
    .find((attempt) => attempt.method === "llm");
  const latestLlmFailure =
    latestLlmAttempt &&
    !latestLlmAttempt.succeeded &&
    latestLlmAttempt.fallback_reason
      ? latestLlmAttempt
      : null;
  const extractedFields =
    doc?.data && Object.keys(doc.data).length > 0 ? doc.data : null;
  const visibleAttempts = attempts.slice(-5);
  const displayRefineStatus =
    doc?.refine_status === "queued" || doc?.refine_status === "working"
      ? doc.refine_status
      : latestLlmFailure
        ? "dead"
        : doc?.refine_status;

  const docId = doc?.id;
  const docStatus = doc?.status;
  const docRefine = doc?.refine_status;
  useEffect(() => {
    if (!docId) return;
    if (docStatus !== "done" && docStatus !== "failed") return;
    let cancelled = false;
    getAttempts(docId)
      .then((a) => {
        if (!cancelled) setAttempts(a);
      })
      .catch(() => {});
    listCorrections(docId)
      .then((c) => {
        if (!cancelled) setHistory(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [docId, docStatus, docRefine]);

  async function retryDocumentRefinement() {
    if (!id || retrying) return;
    setRetrying(true);
    try {
      await retryDocumentRefinementRequest(id);
      show("success", "Cloud refinement retry queued");
      refresh();
    } catch (e) {
      show("error", (e as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  async function saveCorrection(field: string) {
    if (!id || !editing || saving) return;
    setSaving(true);
    try {
      const r = await submitCorrection(id, field, editing.draft);
      show("success", r.changed ? `Corrected ${field}` : "No change");
      setEditing(null);
      refresh();
      listCorrections(id)
        .then((c) => setHistory(c))
        .catch(() => {});
    } catch (e) {
      show("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (error) {
      const isNotFound =
        error.toLowerCase().includes("not found") || error.includes("404");
      const kind = isNotFound ? "warning" : "error";
      show(kind, error);
    }
  }, [error, show]);

  if (error)
    return (
      <div className="page">
        <ErrorState message={error} onRetry={refresh} />
      </div>
    );
  if (!doc)
    return (
      <div className="page">
        <Text variant="muted">Loading…</Text>
      </div>
    );

  return (
    <div className="page">
      <div className={styles["detail-header"]}>
        <Link to="/documents" className={styles["detail-back"]}>
          <i className="bi bi-arrow-left" aria-hidden /> Back to list
        </Link>
        <Heading level={1}>{doc.name}</Heading>
        <div
          key={doc.updated_at}
          className={`${styles["detail-meta"]} fade-swap`}
        >
          {statusBadges(doc.status, displayRefineStatus).map((b, i) => (
            <span
              key={i}
              className={`${styles["detail-status"]} ${styles[`detail-status-${b.variant}`]}`}
            >
              {b.label}
            </span>
          ))}
          <span className={`${styles["detail-status"]} ${styles["detail-status-type"]}`}>
            {doc.document_type}
          </span>
          {(doc.refine_status === "dead" || latestLlmFailure) &&
            doc.refine_status !== "working" &&
            doc.refine_status !== "queued" &&
            doc.status === "done" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={retryDocumentRefinement}
                disabled={retrying}
              >
                {retrying ? "Retrying…" : "Retry AI"}
              </Button>
            )}
          <span className={styles["detail-date"]}>
            <FormattedDate iso={doc.updated_at} inline />
          </span>
        </div>
      </div>

      <div className={styles["detail-card"]}>
        {(doc.status === "pending" || doc.status === "processing") && (
          <Text variant="muted">Processing… polling every 2s</Text>
        )}
        {doc.error && (
          <Text as="p" variant="small" className={styles["detail-error"]}>
            Error: {doc.error}
          </Text>
        )}
        {extractedFields && (
          <table className={styles["detail-table"]}>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {Object.entries(extractedFields).map(([k, v]) => (
                <tr key={k}>
                  <td>{k.replace(/([A-Z])/g, " $1")}</td>
                  <td>
                    {editing?.field === k ? (
                      <span className={styles["detail-edit"]}>
                        <Input
                          value={editing.draft}
                          onChange={(e) =>
                            setEditing({ field: k, draft: e.target.value })
                          }
                          aria-label={`Correct ${k}`}
                        />
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => saveCorrection(k)}
                          disabled={saving}
                        >
                          {saving ? "Saving…" : "Save"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(null)}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <>{v == null ? "—" : String(v)}</>
                    )}
                  </td>
                  <td>
                    {CORRECTABLE.includes(k) && editing?.field !== k && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={styles["detail-edit-button"]}
                        aria-label={`Correct ${k}`}
                        onClick={() =>
                          setEditing({
                            field: k,
                            draft: v == null ? "" : String(v),
                          })
                        }
                      >
                        <i className="bi bi-pencil" aria-hidden />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!extractedFields && (doc.status === "done" || doc.status === "failed") && (
          <EmptyState
            icon="file-earmark-text"
            title="No data extracted"
            message={
              latestLlmFailure
                ? "No fields were extracted. Cloud refinement failed; check the provider quota, then retry or upload a clearer image."
                : "Confidence was too low to fill any fields. Try re-uploading a clearer scan."
            }
            actionTo="/"
            actionLabel="Upload again"
          />
        )}
      </div>

      {attempts.length > 0 && (
        <div className={styles["detail-card"]}>
          <Heading level={2}>Recent extraction attempts</Heading>
          <ol className={styles["detail-timeline"]}>
            {visibleAttempts.map((a, i) => (
              <li key={i} className={styles["detail-attempt"]}>
                <span
                  className={`${styles["detail-attempt-method"]} ${
                    a.succeeded
                      ? styles["detail-status-success"]
                      : styles["detail-status-error"]
                  }`}
                >
                  {a.method}
                </span>
                <Text variant="small">
                  Confidence {Number(a.confidence).toFixed(2)}
                </Text>
                {a.fallback_reason && (
                  <Text variant="small" className={styles["detail-reason"]}>
                    <span
                      className={
                        a.method === "llm" && !a.succeeded
                          ? styles["detail-error"]
                          : undefined
                      }
                    >
                      {a.method === "llm" && !a.succeeded
                        ? `LLM error: ${
                            /429|quota/i.test(a.fallback_reason)
                              ? "Gemini quota exceeded (HTTP 429). Check the provider quota, then retry."
                              : a.fallback_reason
                          }`
                        : `→ ${a.fallback_reason}`}
                    </span>
                  </Text>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {doc.status === "done" &&
        (doc.refine_status === "dead" || latestLlmFailure) && (
          <Text variant="small" className={styles["detail-refinement-note"]}>
            Document processing completed, but optional AI enhancement couldn’t
            finish.
          </Text>
        )}

      {history.length > 0 && (
        <div className={styles["detail-card"]}>
          <Heading level={2}>Correction history</Heading>
          <ul className={styles["detail-history"]}>
            {history.map((c, i) => (
              <li key={i}>
                <Text variant="small">
                  <strong>{c.field}</strong>: {c.original_value ?? "—"} →{" "}
                  {c.corrected_value ?? "—"}
                  {c.extraction_method && ` (was ${c.extraction_method})`}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
