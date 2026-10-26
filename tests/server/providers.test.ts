// @vitest-environment node
/**
 * Provider management: credential storage, masking, CRUD guards and the
 * connectivity probe.
 *
 * The connectivity probe is exercised against a real local HTTP server, so
 * "connected" is an earned result rather than a mocked boolean.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-providers-'));
process.env.NODE_ENV = 'test';
process.env.MODEL_LAB_DB_PATH = path.join(tmpDir, 'providers.db');
process.env.ALLOW_LOOPBACK_PROVIDER = 'true';
process.env.RATE_LIMIT_MAX_REQUESTS = '500';
delete process.env.OPENAI_COMPATIBLE_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;

const FAKE_KEY = 'sk-test-abcdefghijklmnop-1234';

let app: import('express').Express;
let db: typeof import('../../server/db');
let fakeProvider: http.Server;
let fakePort = 0;
let providerId = '';

beforeAll(async () => {
  // A real OpenAI-compatible model list endpoint.
  fakeProvider = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'relay-model-a' }, { id: 'relay-model-b' }],
      }),
    );
  });
  await new Promise<void>((resolve) => fakeProvider.listen(0, '127.0.0.1', () => resolve()));
  fakePort = (fakeProvider.address() as AddressInfo).port;

  db = await import('../../server/db');
  const { app: expressApp, bootstrap } = await import('../../server/app');
  app = expressApp;
  bootstrap();
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeProvider.close(() => resolve()));
  db?.db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('provider creation', () => {
  it('creates a relay provider with an encrypted key', async () => {
    const response = await request(app)
      .post('/api/providers')
      .send({
        name: 'My relay',
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${fakePort}/v1`,
        apiKey: FAKE_KEY,
      })
      .expect(201);

    providerId = response.body.provider.id;
    expect(response.body.provider.hasCredential).toBe(true);
    expect(response.body.provider.credentialSource).toBe('database');
    expect(response.body.provider.isBuiltin).toBe(false);
    expect(response.body.provider.customBaseUrl).toBe(true);
  });

  it('never returns the key, only a masked hint', async () => {
    const response = await request(app).get('/api/providers').expect(200);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('abcdefghijklmnop');
    const provider = response.body.providers.find((entry: { id: string }) => entry.id === providerId);
    expect(provider.credentialHint).toBe('••••1234');
  });

  it('stores ciphertext, not plaintext, in the database', () => {
    const row = db
      .getRow<{ api_key_ciphertext: string | null; api_key_hint: string }>(
        'SELECT api_key_ciphertext, api_key_hint FROM model_providers WHERE id = ?',
        providerId,
      );
    expect(row?.api_key_ciphertext).toBeTruthy();
    expect(row?.api_key_ciphertext).not.toContain(FAKE_KEY);
    expect(row?.api_key_ciphertext?.startsWith('v1:')).toBe(true);
  });

  it('rejects a duplicate name', async () => {
    const response = await request(app)
      .post('/api/providers')
      .send({ name: 'My relay', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' })
      .expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('rejects a malformed body', async () => {
    const response = await request(app).post('/api/providers').send({ name: 'x' }).expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a non-https public URL without the loopback opt-in', async () => {
    // The opt-in is on for this suite, so this asserts the guard for `ftp:`.
    const response = await request(app)
      .post('/api/providers')
      .send({ name: 'Bad scheme', kind: 'custom', baseUrl: 'ftp://example.com/v1' })
      .expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.message).toMatch(/rejected/i);
  });
});

describe('credential lifecycle', () => {
  it('replaces a key without exposing the old one', async () => {
    const response = await request(app)
      .patch(`/api/providers/${providerId}`)
      .send({ apiKey: 'sk-replacement-key-9876' })
      .expect(200);
    expect(response.body.provider.credentialHint).toBe('••••9876');
    expect(JSON.stringify(response.body)).not.toContain('sk-replacement-key-9876');
  });

  it('keeps the key when the field is omitted', async () => {
    const response = await request(app)
      .patch(`/api/providers/${providerId}`)
      .send({ name: 'My relay renamed' })
      .expect(200);
    expect(response.body.provider.hasCredential).toBe(true);
    expect(response.body.provider.credentialHint).toBe('••••9876');
  });

  it('clears the key when null is sent', async () => {
    const response = await request(app)
      .patch(`/api/providers/${providerId}`)
      .send({ apiKey: null })
      .expect(200);
    expect(response.body.provider.hasCredential).toBe(false);
    expect(response.body.provider.credentialSource).toBe('none');
    expect(response.body.provider.credentialHint).toBeNull();
  });

  it('restores the key for the connectivity test', async () => {
    await request(app).patch(`/api/providers/${providerId}`).send({ apiKey: FAKE_KEY }).expect(200);
  });
});

describe('connectivity test', () => {
  it('succeeds against a working provider and lists its models', async () => {
    const response = await request(app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const result = response.body.result;
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.modelCount).toBe(2);
    expect(result.sampleModels).toEqual(['relay-model-a', 'relay-model-b']);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // The key must not appear in the probe result.
    expect(JSON.stringify(response.body)).not.toContain(FAKE_KEY);
  });

  it('fails honestly when the key is wrong', async () => {
    const response = await request(app)
      .post(`/api/providers/${providerId}/test`)
      .send({ apiKey: 'sk-wrong-key-000000' })
      .expect(200);
    expect(response.body.result.ok).toBe(false);
    expect(response.body.result.status).toBe(401);
    expect(response.body.result.message).toMatch(/认证失败|401|无效/);
  });

  it('refuses when there is no key at all', async () => {
    const created = await request(app)
      .post('/api/providers')
      .send({ name: 'Keyless', kind: 'custom', baseUrl: `http://127.0.0.1:${fakePort}/v1` })
      .expect(201);
    const response = await request(app)
      .post(`/api/providers/${created.body.provider.id}/test`)
      .send({})
      .expect(400);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    await request(app).delete(`/api/providers/${created.body.provider.id}`).expect(200);
  });

  it('tests an unsaved key without storing it', async () => {
    const created = await request(app)
      .post('/api/providers')
      .send({ name: 'Try before save', kind: 'custom', baseUrl: `http://127.0.0.1:${fakePort}/v1` })
      .expect(201);
    const id = created.body.provider.id;
    const response = await request(app).post(`/api/providers/${id}/test`).send({ apiKey: FAKE_KEY }).expect(200);
    expect(response.body.result.ok).toBe(true);
    // Still keyless: the probe must not persist anything.
    const list = await request(app).get('/api/providers').expect(200);
    expect(list.body.providers.find((entry: { id: string }) => entry.id === id).hasCredential).toBe(false);
    await request(app).delete(`/api/providers/${id}`).expect(200);
  });
});

describe('model discovery', () => {
  it('lists models and marks which are already registered', async () => {
    const response = await request(app).get(`/api/providers/${providerId}/models`).expect(200);
    expect(response.body.total).toBe(2);
    expect(response.body.models.every((model: { registered: boolean }) => model.registered === false)).toBe(true);
  });

  it('registers discovered models', async () => {
    const response = await request(app)
      .post(`/api/providers/${providerId}/models`)
      .send({ modelIds: ['relay-model-a', 'relay-model-b'] })
      .expect(201);
    expect(response.body.created).toBe(2);

    const again = await request(app).get(`/api/providers/${providerId}/models`).expect(200);
    expect(again.body.models.every((model: { registered: boolean }) => model.registered === true)).toBe(true);
  });

  it('is idempotent when called twice', async () => {
    const response = await request(app)
      .post(`/api/providers/${providerId}/models`)
      .send({ modelIds: ['relay-model-a'] })
      .expect(201);
    expect(response.body.created).toBe(0);
  });
});

describe('deletion guards', () => {
  it('refuses to delete a provider that still has models', async () => {
    const response = await request(app).delete(`/api/providers/${providerId}`).expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toMatch(/model/i);
  });

  it('refuses to delete a built-in provider', async () => {
    const list = await request(app).get('/api/providers').expect(200);
    const builtin = list.body.providers.find((entry: { isBuiltin: boolean }) => entry.isBuiltin);
    expect(builtin).toBeTruthy();
    const response = await request(app).delete(`/api/providers/${builtin.id}`).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('deletes a provider with no models', async () => {
    const created = await request(app)
      .post('/api/providers')
      .send({ name: 'Disposable', kind: 'custom', baseUrl: 'https://example.com/v1' })
      .expect(201);
    await request(app).delete(`/api/providers/${created.body.provider.id}`).expect(200);
    const list = await request(app).get('/api/providers').expect(200);
    expect(list.body.providers.some((entry: { id: string }) => entry.id === created.body.provider.id)).toBe(false);
  });
});

describe('provider status endpoint consistency', () => {
  it('agrees with /api/providers', async () => {
    const providers = await request(app).get('/api/providers').expect(200);
    const status = await request(app).get('/api/settings/provider-status').expect(200);
    const a = providers.body.providers.find((entry: { id: string }) => entry.id === providerId);
    const b = status.body.providers.find((entry: { id: string }) => entry.id === providerId);
    expect(b.hasCredential).toBe(a.hasCredential);
    expect(b.credentialSource).toBe(a.credentialSource);
    expect(b.credentialHint).toBe(a.credentialHint);
    expect(JSON.stringify(status.body)).not.toContain(FAKE_KEY);
  });

  it('reports environment variables by name only', async () => {
    const response = await request(app).get('/api/providers/env-status').expect(200);
    expect(Array.isArray(response.body.variables)).toBe(true);
    for (const entry of response.body.variables) {
      expect(entry).not.toHaveProperty('value');
    }
  });
});
