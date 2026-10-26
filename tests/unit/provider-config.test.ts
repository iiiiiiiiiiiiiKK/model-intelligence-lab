// @vitest-environment node
/**
 * Provider base-URL synchronisation.
 *
 * A seeded database points providers at vendor defaults. When an operator sets
 * `OPENAI_COMPATIBLE_BASE_URL` (a relay / self-hosted gateway), the stored row
 * must follow — runs snapshot the row, so a stale row would silently send
 * traffic to the wrong host. This test covers that contract directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-provider-'));
process.env.NODE_ENV = 'test';
process.env.MODEL_LAB_DB_PATH = path.join(tmpDir, 'provider.db');

let db: typeof import('../../server/db');
let seed: typeof import('../../server/db/seed');
let mappers: typeof import('../../server/db/mappers');

beforeAll(async () => {
  db = await import('../../server/db');
  db.migrate();
  seed = await import('../../server/db/seed');
  seed.seedRegistry();
  mappers = await import('../../server/db/mappers');
});

afterAll(() => {
  db?.db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseUrlOf(id: string): string {
  return mappers.listProviders().find((provider) => provider.id === id)?.baseUrl ?? '';
}

describe('syncProviderBaseUrlsFromEnv', () => {
  it('seeds vendor defaults before any sync', () => {
    expect(baseUrlOf('prov-openai')).toBe('https://api.openai.com/v1');
    expect(baseUrlOf('prov-openai-compatible')).toBe('https://api.openai.com/v1');
  });

  it('pins the matching provider row when a resolver returns a URL', () => {
    const updated = mappers.syncProviderBaseUrlsFromEnv((kind, current) =>
      kind === 'openai-compatible' ? 'https://relay.example.com/v1' : current,
    );
    expect(updated).toBe(1);
    expect(baseUrlOf('prov-openai-compatible')).toBe('https://relay.example.com/v1');
    // Unrelated providers keep their value.
    expect(baseUrlOf('prov-openai')).toBe('https://api.openai.com/v1');
    expect(baseUrlOf('prov-deepseek')).toBe('https://api.deepseek.com/v1');
  });

  it('is idempotent: a second run reports no changes', () => {
    const updated = mappers.syncProviderBaseUrlsFromEnv((kind, current) =>
      kind === 'openai-compatible' ? 'https://relay.example.com/v1' : current,
    );
    expect(updated).toBe(0);
  });

  it('leaves rows untouched when the resolver has no opinion (null)', () => {
    const before = baseUrlOf('prov-deepseek');
    const updated = mappers.syncProviderBaseUrlsFromEnv((_kind, current) => current);
    expect(updated).toBe(0);
    expect(baseUrlOf('prov-deepseek')).toBe(before);
  });

  it('applies an OpenAI override independently', () => {
    mappers.syncProviderBaseUrlsFromEnv((kind, current) =>
      kind === 'openai' ? 'https://openai-proxy.example.com/v1' : current,
    );
    expect(baseUrlOf('prov-openai')).toBe('https://openai-proxy.example.com/v1');
    // The earlier relay value survives.
    expect(baseUrlOf('prov-openai-compatible')).toBe('https://relay.example.com/v1');
  });
});

describe('provider rows never expose secret material', () => {
  it('has no key-bearing column in the API shape', () => {
    for (const provider of mappers.listProviders()) {
      expect(provider).not.toHaveProperty('apiKey');
      expect(provider).not.toHaveProperty('api_key');
      expect(provider).not.toHaveProperty('credential');
      expect(JSON.stringify(provider)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    }
  });

  it('reports credential presence from real resolution, not a stale flag', () => {
    // No key is stored and no env var is set in this suite, so every provider
    // must report "none" / false — a stale cached flag would show as configured.
    mappers.refreshProviderCredentialFlags();
    const providers = mappers.listProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider.hasCredential).toBe(false);
      expect(provider.credentialSource).toBe('none');
      expect(provider.credentialHint).toBeNull();
    }
  });
});
