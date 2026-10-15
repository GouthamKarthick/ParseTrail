/**
 * jobs/refine.ts — Background cloud-refinement worker (Phase 2 async).
 *
 * Uploads stay synchronous and local-only; documents that need cloud help
 * get a refine_jobs row. This worker polls the queue, spends Gemini quota
 * sparingly (rate bucket + daily cap + per-user fairness), merges
 * cloud-filled nulls into stored rows, and records every attempt.
 * No new infra: setInterval + MySQL queue.
 */

import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { logger } from "../config/logger.js";
import { extract, recordAttempts } from "../services/extraction.service.js";
import { needsRefinement } from "../services/confidence.service.js";
import { parseJsonColumn } from "../utils/json.js";

export const REFINE_MAX_ATTEMPTS = 5;
const POLL_MS = Number(process.env.REFINE_POLL_MS ?? 15000);
const RATE_PER_MIN = 10;
const DAILY_CAP = Number(process.env.REFINE_DAILY_CAP ?? 100);

type Outcome = "done" | "dead" | "retry" | "idle" | "quota";

interface RefineJob {
  id: string;
  document_id: string;
  user_id: string | null;
  attempts: number;
}

let tokens = RATE_PER_MIN;
let lastRefill = Date.now();
let lastUserId: string | null = null;
let timer: NodeJS.Timeout | null = null;

/**
 * Refills the in-memory token bucket (10 cloud calls per minute).
 * @returns void
 */
function refillTokens(): void {
  const now = Date.now();
  const elapsedMin = (now - lastRefill) / 60000;
  tokens = Math.min(RATE_PER_MIN, tokens + elapsedMin * RATE_PER_MIN);
  lastRefill = now;
}

/**
 * Checks the daily free-tier quota without consuming.
 * @returns True if a cloud call may proceed
 */
async function quotaAllows(): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const [rows] = await pool.query("SELECT used FROM refine_quota WHERE day=?", [
    day,
  ]);
  const used = (rows as Array<{ used: number }>)[0]?.used ?? 0;
  return used < DAILY_CAP;
}

/**
 * Records one spent cloud call against the daily quota.
 * @returns void
 */
async function quotaConsume(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await pool.query(
    "INSERT INTO refine_quota (day, used) VALUES (?, 1) ON DUPLICATE KEY UPDATE used = used + 1",
    [day],
  );
}

/**
 * Enqueues a refinement job unless one is already pending for the document.
 * @param documentId Document id
 * @param userId Owner id
 * @param reason Human-readable enqueue reason
 * @returns True if a new job was created
 */
export async function enqueueRefineJob(
  documentId: string,
  userId: string,
  reason: string,
): Promise<boolean> {
  const [rows] = await pool.query(
    "SELECT id FROM refine_jobs WHERE document_id=? AND status IN ('queued','working') LIMIT 1",
    [documentId],
  );
  if ((rows as Array<unknown>)[0]) return false;
  await pool.query(
    "INSERT INTO refine_jobs (id, document_id, user_id, status, next_retry_at, error) VALUES (?, ?, ?, 'queued', NOW(), ?)",
    [randomUUID(), documentId, userId, reason],
  );
  logger.info("Refine job enqueued", { documentId, reason });
  return true;
}

/**
 * Immediately queues a new refinement attempt initiated by the document owner.
 * @param documentId Document id
 * @param userId Owner id
 * @returns Current state, or queued when a retry was scheduled
 */
export async function retryRefineJobNow(
  documentId: string,
  userId: string,
): Promise<"queued" | "working"> {
  const [rows] = await pool.query(
    "SELECT id, status FROM refine_jobs WHERE document_id=? AND user_id=? AND status IN ('queued','working') ORDER BY created_at DESC LIMIT 1",
    [documentId, userId],
  );
  const job = (rows as Array<{ id: string; status: string }>)[0];
  if (job?.status === "working") return "working";

  if (job?.status === "queued") {
    await pool.query(
      "UPDATE refine_jobs SET status='queued', attempts=0, error=NULL, next_retry_at=NOW() WHERE id=? AND status='queued'",
      [job.id],
    );
    return "queued";
  }

  await pool.query(
    "INSERT INTO refine_jobs (id, document_id, user_id, status, attempts, next_retry_at, error) VALUES (?, ?, ?, 'queued', 0, NOW(), 'Manual retry')",
    [randomUUID(), documentId, userId],
  );
  logger.info("Refine job manually retried", { documentId });
  return "queued";
}

/**
 * Claims the oldest due job, preferring a different user than last time.
 * @returns Claimed job or null
 */
async function claimJob(): Promise<RefineJob | null> {
  const [rows] = await pool.query(
    "SELECT id, document_id, user_id, attempts FROM refine_jobs WHERE status='queued' AND next_retry_at <= NOW() ORDER BY next_retry_at ASC LIMIT 5",
  );
  const jobs = rows as RefineJob[];
  if (jobs.length === 0) return null;
  const job = jobs.find((j) => j.user_id !== lastUserId) ?? jobs[0];
  const [res] = await pool.query(
    "UPDATE refine_jobs SET status='working', attempts=attempts+1 WHERE id=? AND status='queued'",
    [job.id],
  );
  if ((res as { affectedRows?: number }).affectedRows !== 1) return null;
  return { ...job, attempts: job.attempts + 1 };
}

/**
 * Marks a job done, dead, or re-queued with backoff.
 * @param job Job row
 * @param outcome Done, dead, or retry
 * @param error Optional error message
 * @returns void
 */
async function finishJob(
  job: RefineJob,
  outcome: "done" | "dead" | "retry",
  error?: string,
): Promise<void> {
  if (outcome === "done") {
    await pool.query(
      "UPDATE refine_jobs SET status='done', error=NULL WHERE id=?",
      [job.id],
    );
    return;
  }
  if (outcome === "dead" || job.attempts > REFINE_MAX_ATTEMPTS) {
    await pool.query(
      "UPDATE refine_jobs SET status='dead', error=? WHERE id=?",
      [(error ?? "attempts exhausted").slice(0, 500), job.id],
    );
    logger.warn("Refine job dead", {
      jobId: job.id,
      documentId: job.document_id,
      error,
    });
    return;
  }
  await pool.query(
    "UPDATE refine_jobs SET status='queued', error=?, next_retry_at=DATE_ADD(NOW(), INTERVAL LEAST(3600, POW(2, ?) * 60) SECOND) WHERE id=?",
    [(error ?? "retry").slice(0, 500), job.attempts, job.id],
  );
}

/**
 * Processes a single due refine job: cloud pass, null-fill merge, record.
 * @returns Outcome for logging
 */
export async function processOneRefineJob(): Promise<Outcome> {
  refillTokens();
  if (tokens < 1) return "idle";
  if (!(await quotaAllows())) return "quota";
  const job = await claimJob();
  if (!job) return "idle";
  lastUserId = job.user_id;
  tokens -= 1;
  try {
    const [rows] = await pool.query(
      "SELECT id, path, status, data FROM documents WHERE id=?",
      [job.document_id],
    );
    const doc = (
      rows as Array<{
        id: string;
        path: string;
        status: string;
        data: string | null;
      }>
    )[0];
    if (!doc) {
      await finishJob(job, "dead", "document gone");
      return "dead";
    }
    if (doc.status !== "done") {
      await finishJob(
        job,
        "dead",
        `document not refinable (status ${doc.status})`,
      );
      return "dead";
    }
    const stored: Record<string, unknown> = parseJsonColumn<
      Record<string, unknown>
    >(doc.data as string, {});
    const r = await extract(doc.path, { cloudOnly: true });
    await recordAttempts(job.document_id, r.attempts);
    const cloudOk = r.attempts.some((a) => a.method === "llm" && a.succeeded);
    if (cloudOk) await quotaConsume();
    const merged: Record<string, unknown> = { ...stored };
    let filled = 0;
    for (const [k, v] of Object.entries(r.data as Record<string, unknown>)) {
      if (merged[k] == null && v != null) {
        merged[k] = v;
        filled++;
      }
    }
    if (filled > 0) {
      await pool.query(
        "UPDATE documents SET data=?, updated_at=NOW() WHERE id=?",
        [JSON.stringify(merged), job.document_id],
      );
    }
    const stillNeeded = needsRefinement(merged, r.documentType, r.attempts);
    if (!cloudOk && stillNeeded.needed) {
      await finishJob(
        job,
        "retry",
        `cloud unavailable (${stillNeeded.reason}), backing off`,
      );
      logger.info("Refine job requeued — cloud unavailable", {
        jobId: job.id,
        documentId: job.document_id,
      });
      return "retry";
    }
    await finishJob(job, "done");
    logger.info("Refine job done", {
      jobId: job.id,
      documentId: job.document_id,
      filled,
      method: r.method,
    });
    return "done";
  } catch (e) {
    const msg = (e as Error).message;
    await finishJob(job, "retry", msg);
    logger.warn("Refine job failed, backing off", {
      jobId: job.id,
      error: msg.slice(0, 200),
    });
    return "retry";
  }
}

/**
 * Resets jobs stuck in working (crashed worker) back to queued.
 * The age guard avoids reclaiming a job claimed moments ago when two
 * instances (or a restart) overlap. NOTE: quota check-then-consume and
 * job claiming assume a single worker; multi-replica deploys need an
 * atomic claim (UPDATE ... WHERE status='queued' already narrows it) and
 * a transactional quota counter.
 * @returns void
 */
export async function sweepStale(): Promise<void> {
  try {
    const [dead] = await pool.query(
      "UPDATE refine_jobs SET status='dead', error='stale working job, attempts exhausted' WHERE status='working' AND attempts >= ?",
      [REFINE_MAX_ATTEMPTS],
    );
    const [rows] = await pool.query(
      "UPDATE refine_jobs SET status='queued' WHERE status='working' AND updated_at < NOW() - INTERVAL 5 MINUTE",
    );
    const n = (rows as { affectedRows?: number }).affectedRows ?? 0;
    const d = (dead as { affectedRows?: number }).affectedRows ?? 0;
    if (n > 0 || d > 0) logger.info("Refine sweep", { requeued: n, dead: d });
  } catch (e) {
    logger.warn("Refine sweep failed", { error: (e as Error).message });
  }
}

/**
 * Starts the polling worker. Safe to call once at boot.
 * @returns Stop function
 */
export function startRefineWorker(): () => void {
  void sweepStale();
  if (timer) return () => stopRefineWorker();
  timer = setInterval(() => {
    processOneRefineJob()
      .then((outcome) => {
        if (outcome !== "idle") logger.info("Refine tick", { outcome });
      })
      .catch((e) =>
        logger.warn("Refine tick failed", { error: (e as Error).message }),
      );
  }, POLL_MS);
  logger.info("Refine worker started", {
    pollMs: POLL_MS,
    dailyCap: DAILY_CAP,
  });
  return () => stopRefineWorker();
}

/**
 * Stops the polling worker (tests / shutdown).
 * @returns void
 */
export function stopRefineWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
