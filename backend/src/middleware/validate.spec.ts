import { describe, it, expect, vi } from "vitest";
import { validatePagination, uuidSchema, listQuerySchema } from "./validate.js";

function mockReq(query: Record<string, unknown>) {
  return { query } as any;
}
function mockRes() {
  return {} as any;
}

describe("middleware/validate", () => {
  it("uuidSchema accepts valid UUID and rejects invalid", () => {
    expect(
      uuidSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success,
    ).toBe(true);
    expect(uuidSchema.safeParse("not-uuid").success).toBe(false);
  });

  it("listQuerySchema parses q and document_type", () => {
    const p = listQuerySchema.safeParse({
      limit: "10",
      offset: "0",
      q: "  hello ",
      document_type: "invoice",
    });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.q).toBe("hello");
  });

  it("validatePagination stores _pagination and calls next", () => {
    const req = mockReq({ limit: "10", offset: "5", q: "test" });
    const next = vi.fn();
    validatePagination(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect((req as any)._pagination.limit).toBe(10);
    expect((req as any)._pagination.q).toBe("test");
  });

  it("validatePagination calls next with 400 on invalid pagination", () => {
    const req = mockReq({ limit: "9999" });
    const next = vi.fn();
    validatePagination(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("invalid document_type fails", () => {
    expect(
      listQuerySchema.safeParse({ document_type: "badtype" }).success,
    ).toBe(false);
  });

  it("document_type accepts comma-separated and repeated values", () => {
    const csv = listQuerySchema.safeParse({ document_type: "invoice,receipt" });
    expect(csv.success).toBe(true);
    if (csv.success)
      expect(csv.data.document_type).toEqual(["invoice", "receipt"]);

    const arr = listQuerySchema.safeParse({
      document_type: ["invoice", "receipt"],
    });
    expect(arr.success).toBe(true);
    if (arr.success)
      expect(arr.data.document_type).toEqual(["invoice", "receipt"]);

    const mixed = listQuerySchema.safeParse({
      document_type: "invoice,badtype",
    });
    expect(mixed.success).toBe(false);

    const empty = listQuerySchema.safeParse({ document_type: "" });
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.document_type).toBeUndefined();
  });
});
