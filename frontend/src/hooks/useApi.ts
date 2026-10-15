/**
 * @fileoverview useApi — fetch state (data/error/loading) with toast on failure.
 */

import { useCallback, useEffect, useState } from "react";
import { useToastContext } from "../context/ToastContext";

/**
 * Run an async fetch with loading/error state and error toasts.
 * @param fn - Stable async fetcher
 * @param immediate - Run on mount (default true)
 * @returns Data, error, loading flag, and manual runner
 * @example const { data, loading, run } = useApi(() => getSummary());
 */
export function useApi<T>(fn: () => Promise<T>, immediate = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(immediate);
  const { show } = useToastContext();

  const run = useCallback(
    async (notify = true): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        const d = await fn();
        setData(d);
        return d;
      } catch (e) {
        const msg = (e as Error).message || "Request failed";
        setError(msg);
        if (notify) show("error", msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [fn, show],
  );

  useEffect(() => {
    if (immediate) void run(false);
  }, [immediate, run]);

  return { data, error, loading, run };
}
