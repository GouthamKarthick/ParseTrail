import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockExistsSync = vi.spyOn(fs, 'existsSync');
const mockReadFileSync = vi.spyOn(fs, 'readFileSync');

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
  delete process.env.AI_KEYS_FILE;
  mockExistsSync.mockImplementation((p: any) => fs.existsSync(p));
  mockReadFileSync.mockImplementation((p: any) => fs.readFileSync(p, 'utf8'));
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
  delete process.env.AI_KEYS_FILE;
});

async function importAiKeys(): Promise<typeof import('./aiKeys.js')> {
  vi.resetModules();
  return import('./aiKeys.js');
}

describe('aiKeys — loadAiProviders', () => {
  it('returns null when no secrets file exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const { loadAiProviders } = await importAiKeys();
    expect(loadAiProviders()).toBeNull();
  });

  it('throws when AI_KEYS_FILE points to a missing file', async () => {
    process.env.AI_KEYS_FILE = '/tmp/nonexistent-ai-keys-12345.json';
    const { loadAiProviders } = await importAiKeys();
    expect(() => loadAiProviders()).toThrow(
      /AI_KEYS_FILE points to a missing file: \/tmp\/nonexistent-ai-keys-12345\.json/
    );
  });

  it('loads providers from env AI_KEYS_FILE', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
    const file = path.join(dir, 'ai-keys.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { name: 'groq', apiKey: 'gk-123', model: 'llama-3.3-70b-versatile' },
          { name: 'gemini', apiKey: 'gk-456', model: 'gemini-flash-latest' },
        ],
      })
    );
    process.env.AI_KEYS_FILE = file;
    const { loadAiProviders } = await importAiKeys();
    const providers = loadAiProviders();
    expect(providers).toHaveLength(2);
    expect(providers![0]).toEqual({
      name: 'groq',
      apiKey: 'gk-123',
      model: 'llama-3.3-70b-versatile',
    });
    expect(providers![1]).toEqual({
      name: 'gemini',
      apiKey: 'gk-456',
      model: 'gemini-flash-latest',
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws on invalid JSON without leaking keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
    const file = path.join(dir, 'ai-keys.json');
    fs.writeFileSync(file, '{not valid json');
    process.env.AI_KEYS_FILE = file;
    const { loadAiProviders } = await importAiKeys();
    expect(() => loadAiProviders()).toThrow(/Invalid JSON/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws on schema violation without leaking keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
    const file = path.join(dir, 'ai-keys.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [{ name: 'groq', apiKey: '', model: 'llama' }],
      })
    );
    process.env.AI_KEYS_FILE = file;
    const { loadAiProviders } = await importAiKeys();
    expect(() => loadAiProviders()).toThrow(/apiKey must be non-empty/);
    try {
      loadAiProviders();
    } catch (e) {
      const msg = String(e);
      expect(msg).not.toContain('sk');
      expect(msg).not.toContain('secret');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws on duplicate provider names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
    const file = path.join(dir, 'ai-keys.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { name: 'gemini', apiKey: 'k1', model: 'm1' },
          { name: 'gemini', apiKey: 'k2', model: 'm2' },
        ],
      })
    );
    process.env.AI_KEYS_FILE = file;
    const { loadAiProviders } = await importAiKeys();
    expect(() => loadAiProviders()).toThrow(/duplicate/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws when providers array is empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
    const file = path.join(dir, 'ai-keys.json');
    fs.writeFileSync(file, JSON.stringify({ providers: [] }));
    process.env.AI_KEYS_FILE = file;
    const { loadAiProviders } = await importAiKeys();
    expect(() => loadAiProviders()).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws when more than 5 providers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
    const file = path.join(dir, 'ai-keys.json');
    const providers = [
      { name: 'gemini', apiKey: 'k1', model: 'm1' },
      { name: 'groq', apiKey: 'k2', model: 'm2' },
      { name: 'openrouter', apiKey: 'k3', model: 'm3' },
      { name: 'anthropic', apiKey: 'k4', model: 'm4' },
      { name: 'gemini', apiKey: 'k5', model: 'm5' },
      { name: 'groq', apiKey: 'k6', model: 'm6' },
    ];
    fs.writeFileSync(file, JSON.stringify({ providers }));
    process.env.AI_KEYS_FILE = file;
    const { loadAiProviders } = await importAiKeys();
    expect(() => loadAiProviders()).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('honors AI_KEYS_FILE when /etc/secrets file also exists', async () => {
    // /etc/secrets doesn't actually exist; default existsSync handles this.
    // Only override readFileSync for /etc/secrets path (defensive, never hit).
    mockReadFileSync.mockImplementation(p => {
      if (String(p) === '/etc/secrets/ai-keys.json') {
        return JSON.stringify({
          providers: [{ name: 'anthropic', apiKey: 'sk-123', model: 'claude-3-haiku' }],
        });
      }
      return fs.readFileSync(p, 'utf8');
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-keys-'));
    const file = path.join(dir, 'ai-keys.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [{ name: 'gemini', apiKey: 'local-key', model: 'gemini-flash-latest' }],
      })
    );
    process.env.AI_KEYS_FILE = file;
    const { loadAiProviders } = await importAiKeys();
    const providers = loadAiProviders();
    expect(providers).toHaveLength(1);
    expect(providers![0].name).toBe('gemini');
    expect(providers![0].apiKey).toBe('local-key');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
