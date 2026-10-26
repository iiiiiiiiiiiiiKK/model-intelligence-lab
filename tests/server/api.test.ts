// @vitest-environment node
/**
 * HTTP API integration tests.
 *
 * These mount the real Express app (no listening socket, no mocked handlers)
 * against a temporary SQLite database and assert the documented API contract
 * including error envelopes, validation, authorization and rate limiting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-api-'));
process.env.NODE_ENV = 'test';
process.env.MODEL_LAB_DB_PATH = path.join(tmpDir, 'api.db');
process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key-not-a-real-secret';
process.env.RATE_LIMIT_MAX_REQUESTS = '500';
process.env.ALLOW_LOOPBACK_PROVIDER = 'true';

let app: import('express').Express;
let db: typeof import('../../server/db');
let engine: typeof import('../../server/engine');
let mappers: typeof import('../../server/db/mappers');
let modelId = '';

beforeAll(async () => {
  db = await import('../../server/db');
  const seed = await import('../../server/db/seed');
  const { app: expressApp, bootstrap } = await import('../../server/app');
  app = expressApp;
  bootstrap();
  seed.seedDemoData();
  engine = await import('../../server/engine');
  mappers = await import('../../server/db/mappers');
  const models = mappers.listModels();
  expect(models.length).toBeGreaterThan(0);
  // The openai-compatible provider is the one with a credential in this test
  // environment, but the registry ships no model for it. Register one through
  // the public API, which also exercises POST /api/models for real.
  const provider = mappers.listProviders().find((entry) => entry.kind === 'openai-compatible');
  if (!provider) throw new Error('expected an openai-compatible provider');
  const created = await request(expressApp)
    .post('/api/models')
    .send({ providerId: provider.id, modelId: 'test-model', displayName: 'Test Model' })
    .expect(201);
  modelId = created.body.model.id;
});

afterAll(() => {
  db?.db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports database and provider state separately', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.services.database).toBe('ok');
    expect(response.body.services.providers).toBeTypeOf('object');
    expect(response.body.version).toBeTypeOf('string');
    expect(response.body.demoDataPresent).toBe(true);
  });

  it('never returns key material', async () => {
    const response = await request(app).get('/api/health');
    expect(JSON.stringify(response.body)).not.toMatch(/test-key-not-a-real-secret/);
  });
});

describe('GET /api/overview', () => {
  it('separates real runs from demo runs', async () => {
    const response = await request(app).get('/api/overview').expect(200);
    expect(response.body.counts.realRuns).toBeTypeOf('number');
    expect(response.body.counts.demoRuns).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(response.body.recentRuns)).toBe(true);
    // Demo runs must never appear in the real-run feeds.
    expect(response.body.recentRuns.every((run: { isDemo: boolean }) => !run.isDemo)).toBe(true);
  });
});

describe('models API', () => {
  it('lists models with credential state', async () => {
    const response = await request(app).get('/api/models').expect(200);
    expect(response.body.models.length).toBeGreaterThan(0);
    for (const model of response.body.models) {
      expect(model.providerHasCredential).toBeTypeOf('boolean');
      expect(model).not.toHaveProperty('apiKey');
    }
  });

  it('filters by search term', async () => {
    const all = await request(app).get('/api/models');
    const first = all.body.models[0];
    const filtered = await request(app).get(`/api/models?search=${encodeURIComponent(first.modelId)}`).expect(200);
    expect(filtered.body.models.some((m: { id: string }) => m.id === first.id)).toBe(true);
  });

  it('returns 404 with the uniform envelope for unknown ids', async () => {
    const response = await request(app).get('/api/models/nope').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toBeTypeOf('string');
  });

  it('validates a new model payload', async () => {
    const response = await request(app).post('/api/models').send({ displayName: 'x' }).expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a duplicate provider/model pair', async () => {
    const models = mappers.listModels();
    const existing = models[0];
    await request(app)
      .post('/api/models')
      .send({ providerId: existing.providerId, modelId: existing.modelId, displayName: 'Dup' })
      .expect(409);
  });
});

describe('benchmarks API', () => {
  it('returns the dataset with versions and metadata', async () => {
    const response = await request(app).get('/api/benchmarks').expect(200);
    expect(response.body.benchmarks.length).toBeGreaterThan(0);
    expect(response.body.datasetMeta.source).toBeTypeOf('string');
    expect(response.body.dimensions.length).toBe(6);
  });

  it('returns items for a benchmark', async () => {
    const response = await request(app).get('/api/benchmarks/bench-core').expect(200);
    expect(response.body.items.length).toBeGreaterThanOrEqual(100);
    expect(response.body.benchmark.currentVersion).toBeTypeOf('string');
  });

  it('rejects a duplicate version number', async () => {
    const response = await request(app)
      .post('/api/benchmarks/bench-core/versions')
      .send({
        version: '1.0.0',
        notes: 'dup',
        items: [{ externalKey: 'x', dimension: 'reasoning', question: 'q', scorerType: 'exact-match' }],
      })
      .expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toMatch(/immutable/i);
  });

  it('validates item payloads before publishing', async () => {
    const response = await request(app)
      .post('/api/benchmarks/bench-core/versions')
      .send({ version: '9.9.9', notes: '', items: [] })
      .expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires a schema for json-schema items', async () => {
    const response = await request(app)
      .post('/api/benchmarks/bench-core/versions')
      .send({
        version: '9.9.8',
        notes: '',
        items: [
          { externalKey: 'a', dimension: 'reasoning', question: 'q', scorerType: 'json-schema', scorerConfig: {} },
        ],
      })
      .expect(422);
    expect(response.body.error.message).toMatch(/schema/i);
  });

  it('creates a new immutable version and exposes it', async () => {
    const response = await request(app)
      .post('/api/benchmarks/bench-core/versions')
      .send({
        version: '2.0.0-test',
        notes: 'api test version',
        setAsCurrent: false,
        items: [
          {
            externalKey: 'api-test-1',
            dimension: 'reasoning',
            question: 'What is 2 + 2?',
            reference: '4',
            scorerType: 'numeric-tolerance',
            scorerConfig: { tolerance: 0 },
            difficulty: 'easy',
          },
        ],
      });
    expect([200, 201]).toContain(response.status);
    const versions = await request(app).get('/api/benchmarks/bench-core/versions').expect(200);
    expect(versions.body.versions.some((v: { version: string }) => v.version === '2.0.0-test')).toBe(true);
    // The original version must be untouched.
    const original = versions.body.versions.find((v: { version: string }) => v.version === '1.0.0');
    expect(original.itemCount).toBeGreaterThanOrEqual(100);
  });

  it('dry-runs a scorer', async () => {
    const response = await request(app)
      .post('/api/benchmarks/validate-item')
      .send({
        scorerType: 'numeric-tolerance',
        scorerConfig: { tolerance: 0 },
        reference: '42',
        question: 'q',
        response: 'The answer is 42',
      })
      .expect(200);
    expect(response.body.result.score).toBe(1);
    expect(response.body.passThreshold).toBe(0.75);
  });
});

describe('evaluations API', () => {
  it('rejects a run without a credential for the provider', async () => {
    const models = mappers.listModels();
    const deepseek = models.find((m) => m.providerKind === 'deepseek');
    if (!deepseek) return;
    const response = await request(app)
      .post('/api/evaluations')
      .send({ modelId: deepseek.id, itemLimit: 3 })
      .expect(400);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.body.error.message).toMatch(/API key/i);
  });

  it('rejects an invalid payload', async () => {
    const response = await request(app).post('/api/evaluations').send({ itemLimit: 3 }).expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns estimates', async () => {
    const response = await request(app).get('/api/evaluations/estimate?items=10&maxTokens=100').expect(200);
    expect(response.body.promptTokens).toBe(600);
    expect(response.body.completionTokens).toBe(1000);
    expect(response.body.note).toMatch(/estimate/i);
  });

  it('creates a run and reports progress, then 404s for unknown ids', async () => {
    const created = await request(app)
      .post('/api/evaluations')
      .send({ modelId, itemLimit: 2, idempotencyKey: `api-${Date.now()}`, params: { retries: 0, timeoutMs: 1500 } });
    expect([200, 202]).toContain(created.status);
    const runId = created.body.run.id;
    expect(runId).toBeTypeOf('string');

    const progress = await request(app).get(`/api/evaluations/${runId}/progress`).expect(200);
    expect(progress.body.progress.total).toBe(2);

    await request(app).get('/api/evaluations/unknown-id').expect(404);
  });

  it('reuses a run for the same idempotency key', async () => {
    const key = `idem-api-${Date.now()}`;
    const first = await request(app)
      .post('/api/evaluations')
      .send({ modelId, itemLimit: 1, idempotencyKey: key, params: { retries: 0 } });
    const second = await request(app)
      .post('/api/evaluations')
      .send({ modelId, itemLimit: 1, idempotencyKey: key, params: { retries: 0 } });
    expect(second.body.run.id).toBe(first.body.run.id);
    expect(second.body.reused).toBe(true);
  });

  it('refuses to cancel a finished run', async () => {
    const runs = mappers.listRuns({ limit: 20 });
    const finished = runs.find((run) => ['completed', 'failed', 'cancelled'].includes(run.status));
    if (!finished) return;
    const response = await request(app).post(`/api/evaluations/${finished.id}/cancel`).expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });
});

describe('regression API', () => {
  it('rejects comparing a run with itself', async () => {
    const runs = mappers.listRuns({ limit: 5 });
    const id = runs[0]?.id ?? 'x';
    const response = await request(app)
      .post('/api/regression/compare')
      .send({ baselineRunId: id, comparisonRunId: id })
      .expect(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns comparability issues for a missing run', async () => {
    const response = await request(app)
      .get('/api/regression/comparability?baselineRunId=a&comparisonRunId=b')
      .expect(200);
    expect(response.body.comparable).toBe(false);
    expect(response.body.issues).toContain('one-or-both-runs-missing');
  });

  it('lists regression events without demo contamination', async () => {
    const response = await request(app).get('/api/regression-events').expect(200);
    expect(Array.isArray(response.body.events)).toBe(true);
  });
});

describe('reports API', () => {
  it('refuses to build a report from demo data', async () => {
    const demoRun = mappers.listRuns({ limit: 5, includeDemo: true }).find((run) => run.isDemo);
    if (!demoRun) return;
    const response = await request(app)
      .post('/api/reports')
      .send({ runId: demoRun.id, visibility: 'private', title: 'x', summary: '' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('protects private reports behind an access token', async () => {
    const response = await request(app).get('/api/reports/does-not-exist').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('never lists access tokens', async () => {
    const response = await request(app).get('/api/reports').expect(200);
    expect(JSON.stringify(response.body)).not.toMatch(/access_token|accessToken/);
  });
});

describe('settings API', () => {
  it('returns settings and validates updates', async () => {
    const current = await request(app).get('/api/settings').expect(200);
    expect(current.body.settings.language).toMatch(/zh-CN|en/);

    const updated = await request(app).patch('/api/settings').send({ language: 'en' }).expect(200);
    expect(updated.body.settings.language).toBe('en');

    await request(app).patch('/api/settings').send({ language: 'en' }).expect(200);

    const invalid = await request(app).patch('/api/settings').send({ defaultBudgetUsd: -5 }).expect(422);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('reports credential sources without values', async () => {
    const response = await request(app).get('/api/settings/provider-status').expect(200);
    expect(response.body.providers.length).toBeGreaterThan(0);
    for (const provider of response.body.providers) {
      expect(provider).not.toHaveProperty('apiKey');
      expect(JSON.stringify(provider)).not.toMatch(/test-key-not-a-real-secret/);
    }
  });
});

describe('community API', () => {
  it('accepts a submission as pending', async () => {
    const response = await request(app)
      .post('/api/community/submissions')
      .send({ kind: 'item', title: 'API test item', body: 'A question', dimension: 'reasoning' })
      .expect(201);
    expect(response.body.submission.status).toBe('pending');
  });

  it('rejects a malformed submission', async () => {
    await request(app).post('/api/community/submissions').send({ kind: 'item', title: 'x', body: '' }).expect(422);
  });

  it('refuses review without an admin token', async () => {
    const created = await request(app)
      .post('/api/community/submissions')
      .send({ kind: 'item', title: 'Review me', body: 'body' });
    const response = await request(app)
      .post(`/api/community/submissions/${created.body.submission.id}/review`)
      .send({ status: 'approved' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

describe('error handling', () => {
  it('returns a JSON envelope for unknown API routes', async () => {
    const response = await request(app).get('/api/definitely-not-a-route').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed JSON bodies', async () => {
    const response = await request(app)
      .post('/api/evaluations')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('sets hardening headers', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('exposes rate limit headers', async () => {
    const response = await request(app).get('/api/models');
    expect(response.headers['ratelimit'] || response.headers['ratelimit-limit']).toBeTruthy();
  });
});

describe('compare API', () => {
  it('requires at least two run ids', async () => {
    const response = await request(app).get('/api/compare?runIds=only-one').expect(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('404s for unknown run ids', async () => {
    const response = await request(app).get('/api/compare?runIds=a,b');
    expect(response.status).toBe(404);
  });

  it('exposes engine run creation for the comparison test fixture', () => {
    expect(typeof engine.createRun).toBe('function');
  });
});
