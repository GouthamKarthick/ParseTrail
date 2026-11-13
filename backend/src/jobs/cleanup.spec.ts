import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const state = vi.hoisted(() => ({ batch: 0 }));
const mockQuery = vi.hoisted(() => vi.fn());
const mockUnlink = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());

vi.mock("../db/pool.js", () => ({ pool: { query: mockQuery } }));
vi.mock("fs/promises", () => ({
  default: { unlink: mockUnlink, readdir: mockReaddir },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { pool } from "../db/pool.js";
import { purgeExpired } from "./cleanup.js";

describe("purgeExpired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.batch = 0;
    mockUnlink.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([
      { name: "orphan.pdf", isFile: () => true },
      { name: "retained.pdf", isFile: () => true },
    ]);
    vi.mocked(pool.query).mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("WHERE expires_at < NOW()")) {
        state.batch++;
        if (state.batch === 1)
          return [
            [{ id: "expired-1", path: path.resolve("./uploads/expired-1.pdf") }],
            [],
          ] as never;
        if (state.batch === 2)
          return [
            [{ id: "expired-2", path: path.resolve("./uploads/expired-2.pdf") }],
            [],
          ] as never;
        return [[], []] as never;
      }
      if (String(sql).includes("SELECT path FROM documents"))
        return [
          [{ path: path.resolve("./uploads/retained.pdf") }],
          [],
        ] as never;
      return [{ affectedRows: 1 }, []] as never;
    });
  });

  it("purges all batches, expired auth records, and orphan files", async () => {
    expect(await purgeExpired()).toBe(2);
    expect(state.batch).toBe(3);
    expect(mockUnlink).toHaveBeenCalledWith(
      path.resolve("./uploads/expired-1.pdf"),
    );
    expect(mockUnlink).toHaveBeenCalledWith(
      path.resolve("./uploads/expired-2.pdf"),
    );
    expect(mockUnlink).toHaveBeenCalledWith(
      path.resolve("./uploads/orphan.pdf"),
    );
    expect(mockUnlink).not.toHaveBeenCalledWith(
      path.resolve("./uploads/retained.pdf"),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM password_reset_tokens"),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM users"),
    );
  });
});
