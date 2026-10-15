import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "./error.js";

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("middleware/error", () => {
  it("handles status-bearing error (validation)", () => {
    const res = mockRes();
    errorHandler(
      { status: 400, message: "Invalid pagination" } as any,
      { method: "GET", originalUrl: "/api/documents" } as any,
      res,
      (() => {}) as any,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Invalid pagination" }),
    );
  });

  it("handles Invalid file type → 400", () => {
    const res = mockRes();
    errorHandler(
      new Error("Invalid file type. Allowed: pdf"),
      { method: "POST", originalUrl: "/upload" } as any,
      res,
      (() => {}) as any,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("handles LIMIT_FILE_SIZE → 413", () => {
    const err: any = new Error("File too large");
    err.code = "LIMIT_FILE_SIZE";
    const res = mockRes();
    errorHandler(err, { method: "POST" } as any, res, (() => {}) as any);
    expect(res.status).toHaveBeenCalledWith(413);
  });

  it("else 500", () => {
    const res = mockRes();
    errorHandler(
      new Error("boom"),
      { method: "GET", originalUrl: "/" } as any,
      res,
      (() => {}) as any,
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
