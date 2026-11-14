import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const configState = vi.hoisted(() => ({
  uploadDir: '',
}));
const mockQuery = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ batch: 0 }));

vi.mock('../config.js', () => ({
  config: configState,
}));
vi.mock('../db/pool.js', () => ({
  pool: { query: mockQuery },
}));
vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { purgeExpired } from './cleanup.js';
import { logger } from '../config/logger.js';

let tempDir: string;

async function writeFileWithMtime(filePath: string, content: string, mtimeSec: number) {
  await fs.writeFile(filePath, content);
  const atimeSec = Date.now() / 1000;
  await fs.utimes(filePath, atimeSec, mtimeSec);
}

const oneHourAgoSec = (Date.now() - 60 * 60 * 1000) / 1000;

beforeEach(async () => {
  vi.clearAllMocks();
  state.batch = 0;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt-cleanup-'));
  configState.uploadDir = tempDir;
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes('WHERE expires_at < NOW()')) {
      state.batch++;
      if (state.batch === 1)
        return [[{ id: 'expired-1', path: path.join(tempDir, 'expired-1.pdf') }], []] as never;
      return [[], []] as never;
    }
    if (String(sql).includes('SELECT path FROM documents')) return [[], []] as never;
    return [{ affectedRows: 1 }, []] as never;
  });
});

afterEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('removeOrphanFiles guardrails', () => {
  it('keeps a recent UUID-named file (mtime within 1 hour)', async () => {
    const recent = path.join(tempDir, '550e8400-e29b-41d4-a716-446655440000-recent.pdf');
    await writeFileWithMtime(recent, 'x', Date.now() / 1000);

    await purgeExpired();

    const remaining = await fs.readdir(tempDir);
    expect(remaining).toContain('550e8400-e29b-41d4-a716-446655440000-recent.pdf');
  });

  it('keeps an unrelated non-UUID file', async () => {
    const unrelated = path.join(tempDir, 'readme.txt');
    await fs.writeFile(unrelated, 'x');

    await purgeExpired();

    const remaining = await fs.readdir(tempDir);
    expect(remaining).toContain('readme.txt');
  });

  it('removes an old UUID-named orphan not referenced by any document', async () => {
    const orphan = path.join(tempDir, '11111111-1111-1111-1111-111111111111-orphan.pdf');
    await writeFileWithMtime(orphan, 'x', oneHourAgoSec);

    await purgeExpired();

    const remaining = await fs.readdir(tempDir);
    expect(remaining).not.toContain('11111111-1111-1111-1111-111111111111-orphan.pdf');
  });

  it('keeps an old UUID-named file that is referenced by a document row', async () => {
    const referenced = path.join(tempDir, '22222222-2222-2222-2222-222222222222-ref.pdf');
    await writeFileWithMtime(referenced, 'x', oneHourAgoSec);
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('SELECT path FROM documents')) {
        return [[{ path: referenced }], []] as never;
      }
      return [[], []] as never;
    });

    await purgeExpired();

    const remaining = await fs.readdir(tempDir);
    expect(remaining).toContain('22222222-2222-2222-2222-222222222222-ref.pdf');
  });
});

describe('removeOrphanFiles dangerous-dir refusal', () => {
  it('refuses to run when upload dir is root', async () => {
    configState.uploadDir = '/';
    await purgeExpired();
    expect(logger.error).toHaveBeenCalledWith(
      'Refusing to run orphan cleanup on a dangerous upload dir',
      expect.objectContaining({ uploadDir: '/' })
    );
  });

  it('refuses to run when upload dir is the user home', async () => {
    configState.uploadDir = os.homedir();
    await purgeExpired();
    expect(logger.error).toHaveBeenCalledWith(
      'Refusing to run orphan cleanup on a dangerous upload dir',
      expect.objectContaining({ uploadDir: os.homedir() })
    );
  });

  it('refuses to run when upload dir is the cwd', async () => {
    configState.uploadDir = process.cwd();
    await purgeExpired();
    expect(logger.error).toHaveBeenCalledWith(
      'Refusing to run orphan cleanup on a dangerous upload dir',
      expect.objectContaining({ uploadDir: process.cwd() })
    );
  });
});

describe('purgeExpired expiration path', () => {
  it('unlinks expired document files and runs auth cleanup', async () => {
    const expired = path.join(tempDir, 'expired-1.pdf');
    await writeFileWithMtime(expired, 'x', oneHourAgoSec);
    await purgeExpired();

    const remaining = await fs.readdir(tempDir);
    expect(remaining).not.toContain('expired-1.pdf');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM password_reset_tokens')
    );
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM users'));
  });
});
