/**
 * services/aiKeys.ts — Loads AI provider keys/order from a secrets JSON file.
 *
 * Resolution order:
 *   1. Env var `AI_KEYS_FILE` (absolute path).
 *   2. `/etc/secrets/ai-keys.json` (Render Secret File mount).
 *   3. `backend/secrets/ai-keys.json` (local dev, gitignored).
 *
 * Returns `null` when no file exists. Throws on invalid JSON or schema
 * violations — never printing key values.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

export type AiProviderKey = {
  name: 'gemini' | 'groq' | 'openrouter' | 'anthropic';
  apiKey: string;
  model: string;
};

const aiProviderKeySchema = z.object({
  name: z.enum(['gemini', 'groq', 'openrouter', 'anthropic']),
  apiKey: z.string().min(1, 'apiKey must be non-empty'),
  model: z.string().min(1, 'model must be non-empty'),
});

const aiKeysFileSchema = z.object({
  providers: z.array(aiProviderKeySchema).min(1).max(5),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.dirname(path.dirname(__dirname)); // backend/src/services -> backend

function findKeysFile(): string | null {
  const envFile = process.env.AI_KEYS_FILE;
  if (envFile) {
    if (fs.existsSync(envFile)) return envFile;
    throw new Error(`AI_KEYS_FILE points to a missing file: ${envFile}`);
  }
  const renderSecret = '/etc/secrets/ai-keys.json';
  if (fs.existsSync(renderSecret)) return renderSecret;
  const localFile = path.join(backendDir, 'secrets', 'ai-keys.json');
  if (fs.existsSync(localFile)) return localFile;
  return null;
}

/**
 * Loads AI provider keys/order from the secrets file.
 * @returns Array of providers in file order, or null when no secrets file exists.
 * @throws Error naming the problem (no key values) on invalid file/schema.
 */
export function loadAiProviders(): AiProviderKey[] | null {
  const file = findKeysFile();
  if (!file) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Failed to read AI keys file ${file}: unreadable`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in AI keys file ${file}`);
  }

  const result = aiKeysFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid AI keys file ${file}: ${issues}`);
  }

  const names = result.data.providers.map(p => p.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid AI keys file ${file}: duplicate provider names`);
  }

  return result.data.providers;
}
