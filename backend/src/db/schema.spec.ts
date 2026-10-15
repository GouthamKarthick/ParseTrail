import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./pool.js", () => ({
  pool: { query: vi.fn().mockResolvedValue([[{ cnt: 1 }]]) },
}));

import { pool } from "./pool.js";
import { ensureSchema } from "./schema.js";

describe("db/schema — ensureSchema", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates documents table and runs migrations", async () => {
    const mockQuery = vi.mocked(pool.query);
    await ensureSchema();
    expect(mockQuery).toHaveBeenCalled();
    const allCalls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(allCalls.join(" ")).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(allCalls.join(" ")).toContain(
      "CREATE TABLE IF NOT EXISTS documents",
    );
  });

  it("tolerates migration errors", async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery.mockResolvedValue([[]] as any);
    await expect(ensureSchema()).resolves.toBeUndefined();
  });
});
