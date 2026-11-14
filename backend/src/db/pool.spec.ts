import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pool, withTransaction } from './pool.js';
import type { Mock } from 'vitest';

vi.mock('mysql2/promise', async importOriginal => {
  const actual = await importOriginal<typeof import('mysql2/promise')>();
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn().mockResolvedValue([[]]),
  };
  const mockCreatePool = vi.fn(() => ({
    getConnection: vi.fn().mockResolvedValue(connection),
    query: vi.fn(),
    execute: vi.fn(),
  }));
  return {
    ...actual,
    createPool: mockCreatePool,
    default: { ...actual, createPool: mockCreatePool },
  };
});

describe('db/pool', () => {
  let conn: { beginTransaction: Mock; commit: Mock; rollback: Mock; release: Mock; query: Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    conn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      query: vi.fn().mockResolvedValue([[]]),
    };
    (pool.getConnection as Mock).mockResolvedValue(conn);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports mysql pool with query method', () => {
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe('function');
    expect(typeof pool.execute).toBe('function');
  });

  describe('withTransaction commit path', () => {
    it('begins, runs fn, commits, releases, and returns fn result', async () => {
      const value = await withTransaction(async c => {
        expect(c).toBe(conn);
        expect(c.beginTransaction).toHaveBeenCalledTimes(1);
        return 'done';
      });

      expect(value).toBe('done');
      expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(conn.commit).toHaveBeenCalledTimes(1);
      expect(conn.rollback).not.toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('withTransaction rollback path', () => {
    it('rolls back, rethrows, and releases when fn throws', async () => {
      const err = new Error('boom');
      await expect(
        withTransaction(async () => {
          throw err;
        })
      ).rejects.toThrow(err);

      expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
      expect(conn.rollback).toHaveBeenCalledTimes(1);
      expect(conn.commit).not.toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalledTimes(1);
    });
  });
});
