import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/pool.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../services/extraction.service.js", () => ({
  extract: vi.fn(),
  recordAttempts: vi.fn(),
}));

import { pool } from "../db/pool.js";
import { extract } from "../services/extraction.service.js";
import {
  processOneRefineJob,
  enqueueRefineJob,
  retryRefineJobNow,
  stopRefineWorker,
  sweepStale,
} from "./refine.js";

const mockQuery = () => vi.mocked(pool.query);

function baseSqlMock(opts: {
  job?: Record<string, unknown> | null;
  doc?: Record<string, unknown> | null;
  quotaUsed?: number;
  claimOk?: boolean;
}) {
  const { job = null, doc = null, quotaUsed = 0, claimOk = true } = opts;
  mockQuery().mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes("FROM refine_quota")) return [[{ used: quotaUsed }]] as any;
    if (s.includes("FROM refine_jobs WHERE status"))
      return [[...(job ? [job] : [])]] as any;
    if (s.includes("SET status='working'"))
      return [{ affectedRows: claimOk ? 1 : 0 }] as any;
    if (s.includes("FROM documents WHERE id="))
      return [[...(doc ? [doc] : [])]] as any;
    if (s.includes("SELECT id FROM refine_jobs WHERE document_id="))
      return [[]] as any;
    return [[]] as any;
  });
}

describe("jobs/refine — worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopRefineWorker();
  });

  it("idle when no due jobs", async () => {
    baseSqlMock({ job: null });
    expect(await processOneRefineJob()).toBe("idle");
    expect(extract).not.toHaveBeenCalled();
  });

  it("quota blocks cloud spend without touching jobs", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      quotaUsed: 100,
    });
    expect(await processOneRefineJob()).toBe("quota");
    expect(extract).not.toHaveBeenCalled();
  });

  it("done path merges nulls, records attempts, consumes quota", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: JSON.stringify({ vendor: "V" }),
      },
    });
    vi.mocked(extract).mockResolvedValue({
      data: { vendor: "V", totalAmount: 99 },
      confidence: 0.8,
      method: "local-llm+llm",
      documentType: "invoice",
      documentTypeConfidence: 0.8,
      documentCategory: "financial",
      attempts: [
        {
          method: "llm",
          confidence: 0.9,
          latencyMs: 100,
          cost: 0,
          succeeded: true,
        },
      ],
      typeVotes: ["invoice"],
    } as any);
    expect(await processOneRefineJob()).toBe("done");
    expect(extract).toHaveBeenCalledWith("/tmp/x.pdf", { cloudOnly: true });
    const updateCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("UPDATE documents SET data="),
    );
    expect(updateCall).toBeDefined();
    expect(JSON.stringify(updateCall![1])).toContain("99");
    const quotaCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("refine_quota"),
    );
    expect(quotaCall).toBeDefined();
  });

  it("cloud failure with still-incomplete data requeues", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: JSON.stringify({ vendor: "V" }),
      },
    });
    vi.mocked(extract).mockResolvedValue({
      data: { vendor: "V" },
      confidence: 0.2,
      method: "local-llm",
      documentType: "invoice",
      documentTypeConfidence: 0.8,
      documentCategory: "financial",
      attempts: [
        {
          method: "llm",
          confidence: 0,
          latencyMs: 50,
          cost: 0,
          succeeded: false,
          fallbackReason: "cloud error: Gemini 429",
        },
      ],
      typeVotes: ["invoice"],
    } as any);
    expect(await processOneRefineJob()).toBe("retry");
    const finishCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("UPDATE refine_jobs SET status="),
    );
    expect(String(finishCall![0])).toContain("queued");
    const quotaCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO refine_quota"),
    );
    expect(quotaCall).toBeUndefined();
  });

  it("extract throw backs off with retry", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: { id: "d1", path: "/tmp/x.pdf", status: "done", data: "{}" },
    });
    vi.mocked(extract).mockRejectedValue(new Error("boom"));
    expect(await processOneRefineJob()).toBe("retry");
    const finishCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("UPDATE refine_jobs SET status="),
    );
    expect(finishCall).toBeDefined();
    expect(String(finishCall![0])).toContain("queued");
  });

  it("dead after max attempts", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 5 },
      doc: { id: "d1", path: "/tmp/x.pdf", status: "done", data: "{}" },
    });
    vi.mocked(extract).mockRejectedValue(new Error("boom again"));
    expect(await processOneRefineJob()).toBe("retry");
    const finishCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("status='dead'"),
    );
    expect(finishCall).toBeDefined();
  });

  it("sweepStale requeues only aged working jobs", async () => {
    await sweepStale();
    const requeue = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("SET status='queued'"),
    );
    expect(String(requeue![0])).toContain("INTERVAL 5 MINUTE");
  });

  it("enqueueRefineJob dedupes pending jobs", async () => {
    mockQuery().mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("SELECT id FROM refine_jobs"))
        return [[{ id: "existing" }]] as any;
      return [[]] as any;
    });
    expect(await enqueueRefineJob("d1", "u1", "reason")).toBe(false);
  });

  it("enqueueRefineJob inserts when clear", async () => {
    mockQuery().mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("SELECT id FROM refine_jobs"))
        return [[]] as any;
      return [[]] as any;
    });
    expect(await enqueueRefineJob("d1", "u1", "reason")).toBe(true);
    const insert = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO refine_jobs"),
    );
    expect(insert).toBeDefined();
  });

  it("manual retry immediately resets a queued job's backoff", async () => {
    mockQuery()
      .mockResolvedValueOnce([[{ id: "j1", status: "queued" }]] as any)
      .mockResolvedValueOnce([[]] as any);

    expect(await retryRefineJobNow("d1", "u1")).toBe("queued");
    expect(mockQuery()).toHaveBeenCalledWith(
      expect.stringContaining("next_retry_at=NOW()"),
      ["j1"],
    );
  });

  it("manual retry creates a fresh job after failure", async () => {
    mockQuery()
      .mockResolvedValueOnce([[{ id: "j1", status: "dead" }]] as any)
      .mockResolvedValueOnce([[]] as any);

    expect(await retryRefineJobNow("d1", "u1")).toBe("queued");
    expect(mockQuery()).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO refine_jobs"),
      [expect.any(String), "d1", "u1"],
    );
  });

  it("manual retry does not interfere with a working job", async () => {
    mockQuery().mockResolvedValueOnce([
      [{ id: "j1", status: "working" }],
    ] as any);

    expect(await retryRefineJobNow("d1", "u1")).toBe("working");
    expect(mockQuery()).toHaveBeenCalledOnce();
  });
});
