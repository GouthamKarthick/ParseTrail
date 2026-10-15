/**
 * @fileoverview Polling hook for document processing status.
 * Periodically refetches a document until it reaches a terminal state.
 */

import { useEffect, useRef, useState } from "react";
import { getDocument } from "../api/client";
import type { Document } from "../types";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Check whether background cloud refinement is still active.
 * @param doc - Document snapshot or null
 * @returns True while a refine job is queued or working
 * @example isRefining(doc) // false
 */
export function isRefining(doc: Document | null): boolean {
  return doc?.refine_status === "queued" || doc?.refine_status === "working";
}

/**
 * Poll a document by id until it is done or failed, and while a refine
 * job is active (refinement lands after the base status is terminal).
 * @param id - Document id to poll, or null to disable polling
 * @param intervalMs - Polling interval in milliseconds
 * @returns Current document snapshot and optional error message
 * @example const { doc, error } = usePolling("abc-123", 2000);
 */
export function usePolling(id: string | null, intervalMs = 2000) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const timer = useRef<number | null>(null);
  const refineRounds = useRef(0);

  useEffect(() => {
    if (!id) return;
    const documentId = id;
    let cancelled = false;
    let polling = false;

    function currentInterval(d: Document | null): number {
      if (d && isRefining(d)) {
        refineRounds.current += 1;
        return refineRounds.current > 6 ? intervalMs * 4 : intervalMs;
      }
      refineRounds.current = 0;
      return intervalMs;
    }

    function schedule(ms: number) {
      if (timer.current) window.clearInterval(timer.current);
      if (!cancelled) timer.current = window.setInterval(poll, ms);
    }

    async function poll() {
      if (document.hidden || polling) return;
      polling = true;
      try {
        const d = await getDocument(documentId);

        if (cancelled) return;

        setDoc(d);

        if ((d.status === "done" || d.status === "failed") && !isRefining(d)) {
          if (timer.current) window.clearInterval(timer.current);
          return;
        }
        const next = currentInterval(d);
        if (next !== intervalMs) schedule(next);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          if (timer.current) window.clearInterval(timer.current);
        }
      } finally {
        polling = false;
      }
    }

    function onVisibility() {
      if (document.hidden) {
        if (timer.current) window.clearInterval(timer.current);
      } else {
        void poll();
        schedule(intervalMs);
      }
    }

    poll();
    schedule(intervalMs);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer.current) window.clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, intervalMs, nonce]);

  return { doc, error, refresh: () => setNonce((n) => n + 1) };
}
