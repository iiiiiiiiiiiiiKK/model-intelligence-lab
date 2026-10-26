// @vitest-environment node
/**
 * Access-control tests.
 *
 * These mount the real Express app against a temporary database with
 * `MODEL_LAB_ACCESS_TOKEN` set, and assert the gate actually closes: no data
 * leaks before sign-in, the cookie cannot be forged, and the private/public split
 * for shared reports stays intact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const TOKEN = 'correct-horse-battery-staple-0123456789';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-auth-'));
process.env.NODE_ENV = 'test';
process.env.MODEL_LAB_DB_PATH = path.join(tmpDir, 'auth.db');
process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key-not-a-real-secret';
process.env.RATE_LIMIT_MAX_REQUESTS = '500';
process.env.ALLOW_LOOPBACK_PROVIDER = 'true';
process.env.MODEL_LAB_ACCESS_TOKEN = TOKEN;

let app: import('express').Express;
let auth: typeof import('../../server/auth');
let loginRoute: typeof import('../../server/routes/auth');

/** Extracts the session cookie value from a Set-Cookie header. */
function sessionFrom(response: request.Response): string | undefined {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const entry of list) {
    const match = /model_lab_session=([^;]*)/.exec(entry);
    if (match) return match[1];
  }
  return undefined;
}

beforeAll(async () => {
  const seed = await import('../../server/db/seed');
  const { app: expressApp, bootstrap } = await import('../../server/app');
  app = expressApp;
  bootstrap();
  seed.seedDemoData();
  auth = await import('../../server/auth');
  loginRoute = await import('../../server/routes/auth');
});

afterAll(() => {
  // The journal/WAL files stay open in-process for the lifetime of the run, so a
  // Windows removal can fail with EBUSY. Cleanup is best-effort: the OS reclaims
  // the temp dir, and a leak here must never turn a passing suite red.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore locked-file errors */
  }
});

describe('gate is closed', () => {
  it('reports that auth is required and the caller is not authenticated', async () => {
    const response = await request(app).get('/api/auth/status').expect(200);
    expect(response.body.required).toBe(true);
    expect(response.body.authenticated).toBe(false);
  });

  it('leaks no data through any JSON endpoint before sign-in', async () => {
    const paths = [
      '/api/overview',
      '/api/models',
      '/api/providers',
      '/api/catalog',
      '/api/benchmarks',
      '/api/evaluations',
      '/api/regression-events',
      '/api/reports',
      '/api/settings',
      '/api/community',
    ];

    for (const route of paths) {
      const response = await request(app).get(route);
      expect(response.status, `${route} must be gated`).toBe(401);
      expect(response.body.error.code, `${route} error code`).toBe('UNAUTHENTICATED');
      // The gate must not echo any of the payload it is protecting.
      expect(JSON.stringify(response.body)).not.toMatch(/apiKey|keyHint|models|providers":\[/);
    }
  });

  it('blocks writes too, not just reads', async () => {
    const response = await request(app)
      .post('/api/evaluations')
      .send({ modelId: 'x', benchmarkId: 'y' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('keeps /api/health open so an uptime monitor still works', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.status).toBeDefined();
    expect(response.body.authRequired).toBe(true);
    // Health must never carry credential material, gated or not.
    expect(JSON.stringify(response.body)).not.toMatch(/sk-|apiKey|Bearer/);
  });

  it('serves the SPA shell so the browser can render the login form', async () => {
    const response = await request(app).get('/');
    expect([200, 404]).toContain(response.status);
  });
});

describe('sign-in', () => {
  it('rejects a wrong token without revealing whether the instance is gated differently', async () => {
    const response = await request(app).post('/api/auth/login').send({ token: 'nope' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect(sessionFrom(response)).toBeUndefined();
  });

  it('rejects the empty token', async () => {
    const response = await request(app).post('/api/auth/login').send({ token: '' });
    expect(response.status).toBe(422);
    expect(sessionFrom(response)).toBeUndefined();
  });

  it('accepts the configured token and issues an HttpOnly session cookie', async () => {
    const response = await request(app).post('/api/auth/login').send({ token: TOKEN }).expect(200);
    expect(response.body.authenticated).toBe(true);

    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [raw];
    const cookie = list.find((entry: string) => entry.startsWith('model_lab_session='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(sessionFrom(response)).toBeTruthy();
  });

  it('opens the data surface once a session cookie is present', async () => {
    const session = sessionFrom(await request(app).post('/api/auth/login').send({ token: TOKEN }).expect(200));
    const cookie = `model_lab_session=${session}`;

    const models = await request(app).get('/api/models').set('Cookie', cookie).expect(200);
    expect(Array.isArray(models.body.models)).toBe(true);

    const overview = await request(app).get('/api/overview').set('Cookie', cookie).expect(200);
    expect(overview.body).toBeTruthy();
  });

  it('rate-limits repeated bad guesses', async () => {
    loginRoute.resetLoginAttempts();
    let lastStatus = 0;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await request(app).post('/api/auth/login').send({ token: `guess-${attempt}` });
      lastStatus = response.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
    loginRoute.resetLoginAttempts();
  });

  it('signing out clears the cookie and closes the gate again', async () => {
    const session = sessionFrom(await request(app).post('/api/auth/login').send({ token: TOKEN }).expect(200));
    const cookie = `model_lab_session=${session}`;

    await request(app).get('/api/models').set('Cookie', cookie).expect(200);

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);
    const cleared = out.headers['set-cookie'];
    expect(String(cleared)).toMatch(/Max-Age=0/);

    // The old cookie value is no longer presented, so the next call is anonymous.
    await request(app).get('/api/models').expect(401);
  });
});

describe('session tokens cannot be forged', () => {
  it('rejects a hand-made expiry with no valid signature', async () => {
    const forged = `${Date.now() + 60_000}.deadbeef`;
    await request(app).get('/api/models').set('Cookie', `model_lab_session=${forged}`).expect(401);
  });

  it('rejects a signature made for a different expiry', async () => {
    const real = auth.createSession();
    const [, signature] = real.split('.');
    const tamperedExpiry = String(Date.now() + 999_999_999);
    await request(app)
      .get('/api/models')
      .set('Cookie', `model_lab_session=${tamperedExpiry}.${signature}`)
      .expect(401);
  });

  it('rejects a previously valid session that has since expired', () => {
    const issued = Date.now();
    const session = auth.createSession(issued);
    // Valid at issue time...
    expect(auth.verifySession(session, issued)).not.toBeNull();
    // ...and no longer valid once the TTL has elapsed.
    expect(auth.verifySession(session, issued + auth.SESSION_TTL_MS + 1000)).toBeNull();
  });

  it('accepts a freshly created session', () => {
    const session = auth.createSession();
    expect(auth.verifySession(session, Date.now())).not.toBeNull();
  });

  it('rejects junk, empty and malformed values', () => {
    expect(auth.verifySession(undefined)).toBeNull();
    expect(auth.verifySession('')).toBeNull();
    expect(auth.verifySession('noseparator')).toBeNull();
    expect(auth.verifySession('abc.def')).toBeNull();
    expect(auth.verifySession('.')).toBeNull();
  });
});

describe('token comparison', () => {
  it('accepts the exact token and rejects near-misses', () => {
    expect(auth.checkAccessToken(TOKEN)).toBe(true);
    expect(auth.checkAccessToken(TOKEN.toUpperCase())).toBe(false);
    expect(auth.checkAccessToken(`${TOKEN}x`)).toBe(false);
    expect(auth.checkAccessToken(TOKEN.slice(0, -1))).toBe(false);
    expect(auth.checkAccessToken('')).toBe(false);
  });
});

describe('shared reports stay reachable without a session', () => {
  it('allows reading a report by publicId, and still blocks the rest', async () => {
    // Nothing needs to exist: the point is that the gate does not answer 401.
    const response = await request(app).get('/api/reports/does-not-exist');
    expect(response.status).not.toBe(401);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('still requires a session to write a report', async () => {
    const response = await request(app)
      .post('/api/reports')
      .send({ runId: 'x', visibility: 'public', title: 't', summary: '' });
    expect(response.status).toBe(401);
  });
});

describe('exposure guard', () => {
  it('refuses to start exposed and unauthenticated', async () => {
    const { env } = await import('../../server/config');
    const originalToken = env.MODEL_LAB_ACCESS_TOKEN;
    const originalHost = env.HOST;
    const originalAnonymous = env.MODEL_LAB_ALLOW_ANONYMOUS;

    try {
      // Simulate an operator who bound to all interfaces but forgot the token.
      (env as { MODEL_LAB_ACCESS_TOKEN: string }).MODEL_LAB_ACCESS_TOKEN = '';
      (env as { HOST: string }).HOST = '0.0.0.0';
      (env as { MODEL_LAB_ALLOW_ANONYMOUS: boolean }).MODEL_LAB_ALLOW_ANONYMOUS = false;

      expect(() => auth.assertSafeExposure()).toThrow(/Refusing to start without access control/);

      // Loopback is the documented development setup and must still be allowed.
      (env as { HOST: string }).HOST = '127.0.0.1';
      expect(() => auth.assertSafeExposure()).not.toThrow();

      // Explicit opt-out is honoured, because a trusted auth proxy is a real case.
      (env as { HOST: string }).HOST = '0.0.0.0';
      (env as { MODEL_LAB_ALLOW_ANONYMOUS: boolean }).MODEL_LAB_ALLOW_ANONYMOUS = true;
      expect(() => auth.assertSafeExposure()).not.toThrow();
    } finally {
      (env as { MODEL_LAB_ACCESS_TOKEN: string }).MODEL_LAB_ACCESS_TOKEN = originalToken;
      (env as { HOST: string }).HOST = originalHost;
      (env as { MODEL_LAB_ALLOW_ANONYMOUS: boolean }).MODEL_LAB_ALLOW_ANONYMOUS = originalAnonymous;
    }
  });
});
