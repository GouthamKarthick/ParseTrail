/**
 * @fileoverview Skeleton — shimmer placeholder bars for loading states.
 */

import styles from "./Skeleton.module.scss";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Stacked shimmer bars shown while content loads.
 * @param lines - Number of bars
 * @param className - Optional extra class
 * @returns Skeleton element
 * @example <Skeleton lines={4} />
 */
export function Skeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={[styles.skeleton, className].filter(Boolean).join(" ")}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className={styles["skeleton-bar"]} aria-hidden />
      ))}
    </div>
  );
}

/**
 * Page-level loading shell for route Suspense and guards.
 * @returns Page skeleton element
 * @example <Suspense fallback={<PageSkeleton />} />
 */
export function PageSkeleton() {
  return (
    <div className="page" aria-busy="true">
      <Skeleton lines={5} />
    </div>
  );
}
