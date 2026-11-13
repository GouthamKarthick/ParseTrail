import { describe, it, expect } from 'vitest';
import { pool } from './pool.js';

describe('db/pool', () => {
  it('exports mysql pool with query method', () => {
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe('function');
    expect(typeof pool.execute).toBe('function');
  });
});
