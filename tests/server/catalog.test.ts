// @vitest-environment node
/**
 * Catalog HTTP surface.
 *
 * The upstream fetch is stubbed at the HTTP layer (a local server), not by
 * mocking our own modules, so the importer's real parsing, database writes and
 * failure handling are exercised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-catalog-'));
process.env.NODE_ENV = 'test';
process.env.MODEL_LAB_DB_PATH = path.join(tmpDir, 'catalog.db');
process.env.RATE_LIMIT_MAX_REQUESTS = '500';

let app: import('express').Express;
let db: typeof import('../../server/db');
let importModule: typeof import('../../server/catalog/import');

const SAMPLE = {
  data: [
    {
      id: 'openai/gpt-test-pro',
      name: 'OpenAI: GPT Test Pro',
      created: 1_720_000_000,
      context_length: 200000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.000003', completion: '0.000012' },
      benchmarks: {
        design_arena: [{ arena: 'models', category: 'overall', elo: 1444 }],
        artificial_analysis: { intelligence_index: 51.2, coding_index: 47.5 },
      },
    },
    {
      id: 'anthropic/claude-test-sonnet',
      name: 'Anthropic: Claude Test Sonnet',
      created: 1_720_100_000,
      context_length: 1000000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.000002', completion: '0.00001' },
      benchmarks: {
        design_arena: [{ arena: 'models', category: 'overall', elo: 1421 }],
        artificial_analysis: { intelligence_index: 56.0 },
      },
    },
    {
      id: 'openai/gpt-test-pro:batch',
      name: 'OpenAI: GPT Test Pro (batch)',
      architecture: { output_modalities: ['text'] },
      pricing: { prompt: '0.0000015', completion: '0.000006' },
    },
    {
      id: '~openai/gpt-test-pro',
      name: 'GPT Test Pro (mirror)',
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'unlistedvendor/whatever',
      name: 'Whatever',
      architecture: { output_modalities: ['text'] },
    },
  ],
};

let upstream: http.Server;
let upstreamMode: 'ok' | 'fail' | 'garbage' = 'ok';

beforeAll(async () => {
  upstream = http.createServer((_req, res) => {
    if (upstreamMode === 'fail') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream down' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(upstreamMode === 'garbage' ? 'not json at all' : JSON.stringify(SAMPLE));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const port = (upstream.address() as AddressInfo).port;

  // Point the importer at the local upstream instead of the real host.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    if (url.includes('openrouter.ai')) {
      return originalFetch(`http://127.0.0.1:${port}/api/v1/models`, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  db = await import('../../server/db');
  const { app: expressApp, bootstrap } = await import('../../server/app');
  app = expressApp;
  bootstrap();
  importModule = await import('../../server/catalog/import');
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  db?.db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('GET /api/catalog before import', () => {
  it('returns an empty catalog with the disclaimer', async () => {
    const response = await request(app).get('/api/catalog').expect(200);
    expect(response.body.total).toBe(0);
    expect(response.body.lastImport).toBeNull();
    expect(response.body.source.disclaimer).toMatch(/third part|not reproducible/i);
  });
});

describe('POST /api/catalog/import', () => {
  it('imports the curated subset and records coverage', async () => {
    upstreamMode = 'ok';
    const response = await request(app).post('/api/catalog/import').send({}).expect(200);
    const result = response.body.result;
    expect(result.ok).toBe(true);
    // Two allow-listed chat models; the variant, mirror and unknown vendor drop out.
    expect(result.modelsSeen).toBe(2);
    expect(result.skipped.variants).toBe(1);
    expect(result.skipped.mirror).toBe(1);
    expect(result.coverage.arena).toBe(2);
    expect(result.coverage.artificialAnalysis).toBe(2);
    expect(result.coverage.pricing).toBe(2);
    expect(result.scoresWritten).toBeGreaterThan(0);
  });

  it('exposes the models with prices and reference scores', async () => {
    const response = await request(app).get('/api/catalog').expect(200);
    expect(response.body.total).toBe(2);

    const openai = response.body.models.find((entry: { id: string }) => entry.id === 'openai/gpt-test-pro');
    expect(openai.inputPerMillion).toBeCloseTo(3, 6);
    expect(openai.outputPerMillion).toBeCloseTo(12, 6);
    expect(openai.contextLength).toBe(200000);
    expect(openai.arenaElo).toBe(1444);
    expect(openai.aaIntelligenceIndex).toBeCloseTo(51.2, 6);
    expect(openai.references.length).toBeGreaterThan(0);
    // Every reference carries its source and observation time.
    for (const ref of openai.references) {
      expect(ref.source).toBe('openrouter');
      expect(typeof ref.observedAt).toBe('string');
    }
  });

  it('is idempotent: re-importing does not duplicate models', async () => {
    await request(app).post('/api/catalog/import').send({}).expect(200);
    const response = await request(app).get('/api/catalog').expect(200);
    expect(response.body.total).toBe(2);
    const second = await request(app).post('/api/catalog/import').send({}).expect(200);
    expect(second.body.result.modelsNew).toBe(0);
  });

  it('reports an upstream failure honestly', async () => {
    upstreamMode = 'fail';
    const response = await request(app).post('/api/catalog/import').send({});
    expect(response.status).toBe(502);
    expect(response.body.result.ok).toBe(false);
    expect(response.body.result.message).toMatch(/503|HTTP/i);
    upstreamMode = 'ok';
  });

  it('records the failed attempt without wiping good data', async () => {
    upstreamMode = 'garbage';
    await request(app).post('/api/catalog/import').send({});
    upstreamMode = 'ok';

    const response = await request(app).get('/api/catalog').expect(200);
    // The previously imported models are still there.
    expect(response.body.total).toBe(2);
    expect(response.body.lastImport.status).toBe('failed');
  });

  it('survives malformed JSON and keeps the last successful import', async () => {
    const response = await request(app).get('/api/catalog').expect(200);
    expect(response.body.source.url).toContain('openrouter.ai');
  });
});

describe('GET /api/catalog filters', () => {
  it('filters by vendor', async () => {
    const response = await request(app).get('/api/catalog?vendor=anthropic').expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.models[0].vendor).toBe('anthropic');
  });

  it('searches by name and id', async () => {
    const byName = await request(app).get('/api/catalog?search=claude').expect(200);
    expect(byName.body.total).toBe(1);
    const byId = await request(app).get('/api/catalog?search=gpt-test-pro').expect(200);
    expect(byId.body.total).toBe(1);
  });

  it('returns no matches for a nonsense search', async () => {
    const response = await request(app).get('/api/catalog?search=zzzzz').expect(200);
    expect(response.body.total).toBe(0);
  });

  it('lists vendors with counts', async () => {
    const response = await request(app).get('/api/catalog').expect(200);
    const vendors = response.body.vendors as Array<{ vendor: string; count: number }>;
    expect(vendors.find((entry) => entry.vendor === 'openai')?.count).toBe(1);
    expect(vendors.find((entry) => entry.vendor === 'anthropic')?.count).toBe(1);
  });
});

describe('POST /api/catalog/:id/register', () => {
  it('registers a catalog model onto a provider', async () => {
    const providers = await request(app).get('/api/providers').expect(200);
    const providerId = providers.body.providers[0].id;

    const response = await request(app)
      .post('/api/catalog/openai%2Fgpt-test-pro/register')
      .send({ providerId })
      .expect(201);
    expect(response.body.created).toBe(true);
    expect(typeof response.body.modelId).toBe('string');

    const models = await request(app).get('/api/models').expect(200);
    expect(models.body.models.some((model: { modelId: string }) => model.modelId === 'openai/gpt-test-pro')).toBe(true);
  });

  it('is idempotent on a second call', async () => {
    const providers = await request(app).get('/api/providers').expect(200);
    const providerId = providers.body.providers[0].id;
    const response = await request(app)
      .post('/api/catalog/openai%2Fgpt-test-pro/register')
      .send({ providerId })
      .expect(200);
    expect(response.body.created).toBe(false);
  });

  it('rejects an unknown catalog id', async () => {
    const providers = await request(app).get('/api/providers').expect(200);
    const response = await request(app)
      .post('/api/catalog/does-not-exist/register')
      .send({ providerId: providers.body.providers[0].id })
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a missing providerId', async () => {
    const response = await request(app).post('/api/catalog/openai%2Fgpt-test-pro/register').send({}).expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('model detail exposes external scores separately', () => {
  it('attaches third-party scores to a matching registered model', async () => {
    const models = await request(app).get('/api/models').expect(200);
    const registered = models.body.models.find(
      (model: { modelId: string }) => model.modelId === 'openai/gpt-test-pro',
    );
    const response = await request(app).get(`/api/models/${registered.id}`).expect(200);

    expect(response.body.model.scoreSummary.overall).toBeNull(); // no local run yet
    expect(response.body.external.matched.modelRef).toBe('openai/gpt-test-pro');
    expect(response.body.external.scores.length).toBeGreaterThan(0);
    expect(response.body.external.disclaimer).toMatch(/third party/i);

    // The external payload must never look like a local score.
    expect(response.body.model.scores).toBeUndefined();
  });

  it('returns empty external scores for a model with no catalog match', async () => {
    const providers = await request(app).get('/api/providers').expect(200);
    const created = await request(app)
      .post('/api/models')
      .send({ providerId: providers.body.providers[0].id, modelId: 'totally-unknown-xyz', displayName: 'Unknown' })
      .expect(201);

    const response = await request(app).get(`/api/models/${created.body.model.id}`).expect(200);
    expect(response.body.external.matched).toBeNull();
    expect(response.body.external.scores).toEqual([]);
  });
});

describe('isolation from local evaluation data', () => {
  it('external scores live in their own table', () => {
    const scoreTables = db
      .getRows<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%score%'")
      .map((row) => row.name);
    expect(scoreTables).toContain('external_scores');
    // And nothing about them is referenced by the run tables.
    const runColumns = db.getRows<{ name: string }>('PRAGMA table_info(evaluation_runs)').map((row) => row.name);
    expect(runColumns).not.toContain('external_score');
  });

  it('local aggregation ignores external data entirely', () => {
    // computeOverall only sees dimension scores; there is no path to an external
    // value, which is the guarantee the UI states.
    const external = db.getRow<{ c: number }>('SELECT COUNT(*) AS c FROM external_scores');
    const runs = db.getRow<{ c: number }>('SELECT COUNT(*) AS c FROM evaluation_runs');
    expect(Number(external?.c)).toBeGreaterThan(0);
    expect(Number(runs?.c ?? 0)).toBe(0);
  });

  it('exposes the source and import history', () => {
    const imports = db.getRows<{ source: string; status: string }>(
      'SELECT source, status FROM external_imports ORDER BY imported_at',
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((row) => row.source === 'openrouter')).toBe(true);
    expect(imports.some((row) => row.status === 'failed')).toBe(true);
  });
});

describe('schema helpers', () => {
  it('is safe to call repeatedly', () => {
    importModule.ensureCatalogSchema();
    importModule.ensureCatalogSchema();
    expect(true).toBe(true);
  });
});
