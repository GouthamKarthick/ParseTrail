import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.REFINE_DAILY_CAP = "5";
});

vi.mock("../db/pool.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("fs/promises", () => ({
  default: {
    access: vi.fn().mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    ),
    readFile: vi.fn(),
  },
}));
vi.mock("../services/extraction.service.js", () => ({
  extract: vi.fn(),
  extractFromText: vi.fn(),
  recordAttempts: vi.fn(),
}));

import { pool } from "../db/pool.js";
import fs from "fs/promises";
import {
  extract,
  extractFromText,
} from "../services/extraction.service.js";
import {
  processOneRefineJob,
  enqueueRefineJob,
  retryRefineJobNow,
  releaseWorkingJobs,
  stopRefineWorker,
  reserveRefineQuota,
  sweepStale,
} from "./refine.js";
import { recordAttempts } from "../services/extraction.service.js";

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
    if (s.includes("UPDATE refine_quota SET used=used+1"))
      return [{ affectedRows: quotaUsed < 5 ? 1 : 0 }] as any;
    if (s.includes("INSERT INTO refine_quota")) return [[]] as any;
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

  it("quota blocks cloud spend and releases the claimed job", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: "{}",
        extracted_text: "Invoice amount 99",
      },
      quotaUsed: 100,
    });

    expect(await processOneRefineJob()).toBe("quota");
    expect(extract).not.toHaveBeenCalled();
  });

  it("does not reserve more than the daily cap under 20 parallel claims", async () => {
    let used = 0;
    mockQuery().mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("INSERT INTO refine_quota")) return [[]] as any;
      if (String(sql).includes("UPDATE refine_quota SET used=used+1")) {
        if (used >= 5) return [{ affectedRows: 0 }] as any;
        used++;
        return [{ affectedRows: 1 }] as any;
      }
      return [[]] as any;
    });

    const reservations = await Promise.all(
      Array.from({ length: 20 }, () => reserveRefineQuota()),
    );
    expect(reservations.filter(Boolean)).toHaveLength(5);
    expect(used).toBe(5);
  });

  it("done path merges nulls, records attempts, consumes quota", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: JSON.stringify({ vendor: "V" }),
        extracted_text: "Invoice amount 99",
      },
    });
    vi.mocked(extractFromText).mockResolvedValue({
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
    expect(extractFromText).toHaveBeenCalledWith("Invoice amount 99");
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

  it("pending doc: local extraction marks done, caches text, no cloud quota", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "pending",
        data: null,
        extracted_text: null,
      },
    });
    vi.mocked(fs.access).mockResolvedValueOnce(undefined);
    vi.mocked(extract).mockResolvedValue({
      data: { vendor: "V", totalAmount: 10 },
      confidence: 0.9,
      method: "regex",
      documentType: "invoice",
      documentTypeConfidence: 0.9,
      documentCategory: "financial",
      attempts: [],
      extractedText: "Invoice total 10",
      typeVotes: ["invoice"],
    } as any);
    expect(await processOneRefineJob()).toBe("done");
    expect(extract).toHaveBeenCalledWith("/tmp/x.pdf", { allowCloud: false });
    expect(recordAttempts).toHaveBeenCalledWith("d1", []);
    const doneCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("UPDATE documents SET status='done'"),
    );
    expect(doneCall).toBeDefined();
    expect(String(doneCall![0])).toContain("content_fingerprint");
    const quotaCall = mockQuery().mock.calls.find((c) =>
      String(c[0]).includes("refine_quota"),
    );
    expect(quotaCall).toBeUndefined();
  });

  it("pending doc with missing source file is dead with source_unavailable", async () => {
    const errno = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(fs.access).mockRejectedValueOnce(errno);
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/missing.pdf",
        status: "pending",
        data: null,
        extracted_text: null,
      },
    });
    expect(await processOneRefineJob()).toBe("dead");
    expect(extract).not.toHaveBeenCalled();
    const deadCall = mockQuery().mock.calls.find((call) =>
      String(call[0]).includes("status='dead'"),
    );
    expect(deadCall).toBeDefined();
    expect(deadCall![1]).toContain("source_unavailable");
  });

  it("ignores an overlapping tick while a job is being processed", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: "{}",
        extracted_text: "Invoice amount 99",
      },
    });
    let finishExtraction!: (
      value: Awaited<ReturnType<typeof extractFromText>>,
    ) => void;
    vi.mocked(extractFromText).mockReturnValue(
      new Promise((resolve) => {
        finishExtraction = resolve;
      }),
    );

    const firstTick = processOneRefineJob();
    await vi.waitFor(() => expect(extractFromText).toHaveBeenCalledOnce());
    expect(await processOneRefineJob()).toBe("idle");
    finishExtraction({
      data: { totalAmount: 99 },
      confidence: 0.9,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.9,
      documentCategory: "financial",
      attempts: [
        {
          method: "llm",
          confidence: 0.9,
          succeeded: true,
          latencyMs: 1,
          cost: 0,
        },
      ],
      typeVotes: ["invoice"],
      extractedText: "Invoice amount 99",
    });
    expect(await firstTick).toBe("done");
    expect(
      mockQuery().mock.calls.filter((call) =>
        String(call[0]).includes("SET status='working'"),
      ),
    ).toHaveLength(1);
  });

  it("cloud failure with still-incomplete data requeues", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: JSON.stringify({ vendor: "V" }),
        extracted_text: "Invoice amount 99",
      },
    });
    vi.mocked(extractFromText).mockResolvedValue({
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
    expect(
      mockQuery().mock.calls.some((c) =>
        String(c[0]).includes("UPDATE refine_quota SET used=used+1"),
      ),
    ).toBe(true);
  });

  it("extract throw backs off with retry", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: "{}",
        extracted_text: "Invoice amount 99",
      },
    });
    vi.mocked(extractFromText).mockRejectedValue(new Error("boom"));
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
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: "{}",
        extracted_text: "Invoice amount 99",
      },
    });
    vi.mocked(extractFromText).mockRejectedValue(new Error("boom again"));
    expect(await processOneRefineJob()).toBe("dead");
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

  it("marks jobs dead with source_unavailable when file and cached text are missing", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/path/that/does/not/exist",
        status: "done",
        data: "{}",
        extracted_text: null,
      },
    });
    expect(await processOneRefineJob()).toBe("dead");
    const deadUpdate = mockQuery().mock.calls.find((call) =>
      String(call[0]).includes("status='dead'"),
    );
    expect(deadUpdate?.[1]).toContain("source_unavailable");
    expect(extract).not.toHaveBeenCalled();
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

  it("does not finalize an active job after shutdown releases it", async () => {
    baseSqlMock({
      job: { id: "j1", document_id: "d1", user_id: "u1", attempts: 0 },
      doc: {
        id: "d1",
        path: "/tmp/x.pdf",
        status: "done",
        data: "{}",
        extracted_text: "Invoice amount 99",
      },
    });
    let finishExtraction!: (
      value: Awaited<ReturnType<typeof extractFromText>>,
    ) => void;
    vi.mocked(extractFromText).mockReturnValue(
      new Promise((resolve) => {
        finishExtraction = resolve;
      }),
    );

    const activeTick = processOneRefineJob();
    await vi.waitFor(() => expect(extractFromText).toHaveBeenCalledOnce());
    await releaseWorkingJobs();
    finishExtraction({
      data: { totalAmount: 99 },
      confidence: 0.9,
      method: "llm",
      documentType: "invoice",
      documentTypeConfidence: 0.9,
      documentCategory: "financial",
      attempts: [],
      typeVotes: ["invoice"],
      extractedText: "Invoice amount 99",
    });
    expect(await activeTick).toBe("idle");
    expect(recordAttempts).not.toHaveBeenCalled();
    expect(
      mockQuery().mock.calls.some((call) =>
        String(call[0]).includes("UPDATE documents SET data="),
      ),
    ).toBe(false);
    expect(
      mockQuery().mock.calls.some((call) =>
        String(call[0]).includes("attempts=GREATEST(0, attempts-1)"),
      ),
    ).toBe(true);
  });
});
