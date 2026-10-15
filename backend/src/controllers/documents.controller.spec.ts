import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/pool.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../services/extraction.service.js", () => ({
  extract: vi.fn(),
  recordAttempts: vi.fn(),
}));
vi.mock("../services/dedup.service.js", () => ({
  findDuplicateByContent: vi.fn(),
}));
vi.mock("../utils/conversion.js", () => ({
  convertWithMeta: vi.fn(),
  applyConversion: vi.fn(),
  clearConversion: vi.fn(),
}));

import { pool } from "../db/pool.js";
import { extract } from "../services/extraction.service.js";
import { findDuplicateByContent } from "../services/dedup.service.js";
import {
  uploadDocument,
  listDocuments,
  getDocument,
  getAttempts,
  correctField,
  listCorrections,
  correctionStats,
} from "./documents.controller.js";

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("controller — uploadDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 when no file", async () => {
    const res = mockRes();
    await uploadDocument(
      { user: { id: "test-user", email: "test@example.com" } } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("inline flow: pending→processing→done, returns 201", async () => {
    const mockQuery = vi.mocked(pool.query);
    // INSERT pending, SELECT created_at, UPDATE processing, extract, dedup, UPDATE done, final 201
    mockQuery
      .mockResolvedValueOnce([[]] as any) // INSERT
      .mockResolvedValueOnce([
        [{ created_at: new Date().toISOString() }],
      ] as any) // SELECT created_at
      .mockResolvedValueOnce([[]] as any) // UPDATE processing
      .mockResolvedValueOnce([[]] as any); // UPDATE done
    vi.mocked(extract).mockResolvedValue({
      data: {
        vendor: "V",
        invoiceNumber: "INV1",
        totalAmount: 10,
        currency: "INR",
      },
      confidence: 1,
      method: "regex",
      documentType: "invoice",
      documentTypeConfidence: 0.9,
    } as any);
    vi.mocked(findDuplicateByContent).mockResolvedValue({
      duplicate: false,
    } as any);

    const req: any = {
      user: { id: "test-user", email: "test@example.com" },
      file: {
        filename: "550e8400-e29b-41d4-a716-446655440000-test.pdf",
        originalname: "test.pdf",
        path: "/tmp/test",
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), status: "done" }),
    );
  });

  it("duplicate preserves corrections and recomputes converted totals", async () => {
    const { applyConversion } = await import("../utils/conversion.js");
    vi.mocked(applyConversion).mockImplementation(async (data: any) => {
      data.totalAmountConverted = 168314.71;
      data.currencyConverted = "INR";
      data.conversionRate = 106.5283;
      data.conversionAt = "2026-10-15T00:00:00.000Z";
    });
    const mockQuery = vi.mocked(pool.query);
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM corrections WHERE document_id=")) {
        return [[{ field: "totalAmount", corrected_value: "1580" }]] as any;
      }
      return [[]] as any;
    });
    vi.mocked(extract).mockResolvedValue({
      data: {
        vendor: "V",
        totalAmount: 1850,
        currency: "EUR",
        totalAmountConverted: 2035,
        currencyConverted: "INR",
        conversionRate: 1.1,
        conversionAt: "2026-10-14T00:00:00.000Z",
      },
      confidence: 0.8,
      method: "local-llm",
      documentType: "invoice",
      documentTypeConfidence: 0.85,
      documentCategory: "financial",
      attempts: [],
      typeVotes: ["invoice"],
    } as any);
    vi.mocked(findDuplicateByContent).mockResolvedValue({
      duplicate: true,
      duplicateOf: "existing-id",
    } as any);
    const req: any = {
      user: { id: "test-user", email: "test@example.com" },
      file: {
        filename: "550e8400-e29b-41d4-a716-446655440000-dup3.pdf",
        originalname: "dup3.pdf",
        path: "/tmp/dup3",
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, vi.fn());
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE documents SET data="),
    );
    const updateParams = updateCall?.[1] as unknown[] | undefined;
    const savedData = JSON.parse(String(updateParams?.[0])) as Record<
      string,
      unknown
    >;
    expect(savedData.totalAmount).toBe(1580);
    expect(savedData.totalAmountConverted).toBe(168314.71);
    expect(savedData.currencyConverted).toBe("INR");
    expect(savedData.conversionRate).toBe(106.5283);
    expect(savedData.conversionAt).toEqual(expect.any(String));
    vi.mocked(pool.query).mockReset();
  });

  it("duplicate → 409 updates existing, does not add", async () => {
    const mockQuery = vi.mocked(pool.query);
    // For duplicate, uploadDocument extracts first, finds duplicate, updates existing, deletes new file — no INSERT
    mockQuery.mockResolvedValueOnce([[]] as any); // UPDATE existing duplicate
    vi.mocked(extract).mockResolvedValue({
      data: {
        vendor: "V",
        invoiceNumber: "DUP",
        totalAmount: 10,
        currency: "USD",
      },
      confidence: 1,
      method: "local-llm",
      documentType: "receipt",
      documentTypeConfidence: 0.85,
      documentCategory: "financial",
    } as any);
    vi.mocked(findDuplicateByContent).mockResolvedValue({
      duplicate: true,
      duplicateOf: "existing-id",
    } as any);

    const req: any = {
      user: { id: "test-user", email: "test@example.com" },
      file: {
        filename: "550e8400-e29b-41d4-a716-446655440000-dup.pdf",
        originalname: "dup.pdf",
        path: "/tmp/dup",
      },
    };
    const res = mockRes();
    await uploadDocument(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "DUPLICATE_UPDATED",
        duplicateOf: "existing-id",
      }),
    );
    // Should have updated existing, not inserted new
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE documents SET data="),
      expect.anything(),
    );
  });
});

describe("controller — listDocuments / getDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listDocuments handles q escape and document_type filter", async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([[{ cnt: 1 }]] as any)
      .mockResolvedValueOnce([[{ id: "a", name: "x", data: null }]] as any)
      .mockResolvedValueOnce([[]] as any);
    const req: any = {
      user: { id: "test-user", email: "test@example.com" },
      query: {},
      _pagination: {
        limit: 10,
        offset: 0,
        q: "100%_test",
        document_type: ["invoice"],
      },
    };
    const res: any = { json: vi.fn() };
    await listDocuments(req, res, vi.fn());
    expect(mockQuery).toHaveBeenCalled();
    const countSql = mockQuery.mock.calls[0][0] as unknown as string;
    expect(countSql).toContain("name LIKE ?");
    expect(countSql).toContain("document_type IN (?)");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1 }),
    );
  });

  it("listDocuments supports multiple document_types", async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([[{ cnt: 2 }]] as any)
      .mockResolvedValueOnce([[{ id: "a", name: "x", data: null }]] as any)
      .mockResolvedValueOnce([[]] as any);
    const req: any = {
      user: { id: "test-user", email: "test@example.com" },
      query: {},
      _pagination: {
        limit: 10,
        offset: 0,
        document_type: ["invoice", "receipt"],
      },
    };
    const res: any = { json: vi.fn() };
    await listDocuments(req, res, vi.fn());
    const countSql = mockQuery.mock.calls[0][0] as unknown as string;
    const countParams = mockQuery.mock.calls[0][1] as unknown as unknown[];
    expect(countSql).toContain("document_type IN (?,?)");
    expect(countParams).toContain("invoice");
    expect(countParams).toContain("receipt");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2 }),
    );
  });

  it("getDocument 400 invalid uuid", async () => {
    const res = mockRes();
    await getDocument(
      {
        params: { id: "bad" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("getDocument 404 when not found", async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const res = mockRes();
    await getDocument(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("getDocument 200 returns parsed data", async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "x",
          data: JSON.stringify({ vendor: "V" }),
          status: "done",
        },
      ],
    ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await getDocument(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { vendor: "V" } }),
    );
    expect(res.json.mock.calls[0][0]).not.toHaveProperty("path");
  });

  it("getAttempts 401 when unauthenticated", async () => {
    const res = mockRes();
    await getAttempts(
      { params: { id: "550e8400-e29b-41d4-a716-446655440000" } } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("getAttempts 400 invalid uuid", async () => {
    const res = mockRes();
    await getAttempts(
      {
        params: { id: "bad" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("getAttempts 404 when document not found", async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const res = mockRes();
    await getAttempts(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("reprocessDocument 200 re-runs local and enqueues when incomplete", async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([
        [{ id: "550e8400-e29b-41d4-a716-446655440000", path: "/tmp/x.pdf" }],
      ] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([[]] as any);
    vi.mocked(extract).mockResolvedValue({
      data: { vendor: "V" },
      confidence: 0.3,
      method: "rule-based",
      documentType: "invoice",
      documentTypeConfidence: 0.8,
      documentCategory: "financial",
      attempts: [],
      typeVotes: ["invoice"],
    } as any);
    const { reprocessDocument } = await import("./documents.controller.js");
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await reprocessDocument(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "done", enqueued: true }),
    );
  });

  it("reprocessDocument 404 when missing", async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const { reprocessDocument } = await import("./documents.controller.js");
    const res = mockRes();
    await reprocessDocument(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("correctField 400 on unknown field", async () => {
    const res = mockRes();
    await correctField(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "u1", email: "t@e.com" },
        body: { field: "hacker", value: "x" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("correctField 400 on invalid totalAmount", async () => {
    const res = mockRes();
    await correctField(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "u1", email: "t@e.com" },
        body: { field: "totalAmount", value: "abc" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("correctField 404 when missing", async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const res = mockRes();
    await correctField(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "u1", email: "t@e.com" },
        body: { field: "totalAmount", value: 100 },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("correctField 200 updates field and logs history", async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery
      .mockResolvedValueOnce([
        [
          {
            id: "d1",
            data: JSON.stringify({ vendor: "V", totalAmount: 1850 }),
          },
        ],
      ] as any)
      .mockResolvedValueOnce([[]] as any)
      .mockResolvedValueOnce([
        [{ method: "local-llm", confidence: 0.7 }],
      ] as any)
      .mockResolvedValueOnce([[]] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await correctField(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "u1", email: "t@e.com" },
        body: { field: "totalAmount", value: 1580 },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        field: "totalAmount",
        original: 1850,
        corrected: 1580,
        changed: true,
      }),
    );
    const updateCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE documents SET data="),
    );
    expect(JSON.stringify(updateCall![1])).toContain("1580");
    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO corrections"),
    );
    expect(insertCall).toBeDefined();
  });

  it("correctField reports unchanged when value matches", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce([
      [{ id: "d1", data: JSON.stringify({ vendor: "V" }) }],
    ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await correctField(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "u1", email: "t@e.com" },
        body: { field: "vendor", value: "V" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ changed: false }),
    );
  });

  it("listCorrections 200 returns history", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce([[{ id: "d1" }]] as any)
      .mockResolvedValueOnce([
        [
          {
            field: "totalAmount",
            original_value: "1850",
            corrected_value: "1580",
          },
        ],
      ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await listCorrections(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "u1", email: "t@e.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ corrections: expect.any(Array) }),
    );
  });

  it("correctionStats 200 aggregates", async () => {
    vi.mocked(pool.query).mockResolvedValue([[]] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await correctionStats(
      { user: { id: "u1", email: "t@e.com" } } as any,
      res,
      vi.fn(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        byField: expect.any(Array),
        byType: expect.any(Array),
        byMethod: expect.any(Array),
      }),
    );
  });

  it("getAttempts 200 returns attempt rows in order", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce([[{ id: "doc-1" }]] as any)
      .mockResolvedValueOnce([
        [
          {
            method: "heuristic-detect",
            confidence: 0.85,
            latency_ms: 0,
            cost_estimate: 0,
            succeeded: 1,
            fallback_reason: null,
            created_at: "2026-09-24",
          },
          {
            method: "rule-based",
            confidence: 0.68,
            latency_ms: 3,
            cost_estimate: 0,
            succeeded: 1,
            fallback_reason: null,
            created_at: "2026-09-24",
          },
        ],
      ] as any);
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await getAttempts(
      {
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
        user: { id: "test-user", email: "test@example.com" },
      } as any,
      res,
      vi.fn(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: expect.arrayContaining([
          expect.objectContaining({ method: "rule-based" }),
        ]),
      }),
    );
  });
});
