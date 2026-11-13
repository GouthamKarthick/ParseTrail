import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue([[{ cnt: 1 }]]) },
}));

import { pool } from './pool.js';
import { ensureSchema } from './schema.js';

describe('db/schema — ensureSchema', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates documents table and runs migrations', async () => {
    const mockQuery = vi.mocked(pool.query);
    await ensureSchema();
    expect(mockQuery).toHaveBeenCalled();
    const allCalls = mockQuery.mock.calls.map(c => String(c[0]));
    expect(allCalls.join(' ')).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(allCalls.join(' ')).toContain('CREATE TABLE IF NOT EXISTS documents');
    expect(allCalls.join(' ')).toContain(
      'INSERT IGNORE INTO schema_migrations (version, name) VALUES (1,'
    );
    expect(allCalls.join(' ')).toContain(
      'INSERT IGNORE INTO schema_migrations (version, name) VALUES (2,'
    );
    expect(allCalls.join(' ')).toContain(
      'INSERT IGNORE INTO schema_migrations (version, name) VALUES (3,'
    );
    expect(allCalls.join(' ')).toContain(
      "REFERENCED_TABLE_NAME='users' AND REFERENCED_COLUMN_NAME='id'"
    );
    expect(allCalls.join(' ')).not.toContain('ADD CONSTRAINT fk_doc_user');
  });

  it('does not rerun recorded migrations', async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('SELECT version FROM schema_migrations'))
        return [[{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }], []] as any;
      return [[{ cnt: 1 }], []] as any;
    });

    await ensureSchema();
    expect(
      mockQuery.mock.calls.some(call =>
        String(call[0]).includes('INSERT IGNORE INTO schema_migrations')
      )
    ).toBe(false);
  });

  it('propagates migration errors', async () => {
    const mockQuery = vi.mocked(pool.query);
    mockQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(ensureSchema()).rejects.toThrow('database unavailable');
  });
});
