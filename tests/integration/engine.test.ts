// @vitest-environment node
/**
 * End-to-end engine test.
 *
 * This does NOT mock the model call. It starts a real HTTP server that speaks
 * the OpenAI chat-completions protocol, points the adapter at it, and runs a
 * genuine evaluation: real fetch, real timeout handling, real retries, real
 * scoring, real SQLite persistence, real regression analysis.
 *
 * A separate case points the adapter at an unreachable port and asserts the run
 * fails loudly instead of reporting success.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-it-'));
const dbPath = path.join(tmpDir, 'test.db');

// Environment must be set before the server modules are imported, because
// `config.ts` parses process.env at module load.
process.env.NODE_ENV = 'test';
process.env.MODEL_LAB_DB_PATH = dbPath;
process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key-not-a-real-secret';
process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://example.invalid/v1';
process.env.EVAL_MAX_RETRIES = '1';
process.env.EVAL_REQUEST_TIMEOUT_MS = '4000';
// Required to let the SSRF guard reach the local test provider.
process.env.ALLOW_LOOPBACK_PROVIDER = 'true';

type Server = http.Server;

interface FakeProviderOptions {
  /** Behaviour per request index. */
  failFirst?: number;
  delayMs?: number;
  alwaysFail?: boolean;
  answer?: (prompt: string) => string;
}

interface FakeProvider {
  server: Server;
  port: number;
  /** Number of HTTP requests received so far. */
  calls: () => number;
}

function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      callCount += 1;

      if (options.alwaysFail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'simulated provider outage' } }));
        return;
      }

      if (options.failFirst && callCount <= options.failFirst) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited' } }));
        return;
      }

      let prompt = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content: string }> };
        prompt = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
      } catch {
        /* ignore */
      }

      const send = () => {
        const content = options.answer ? options.answer(prompt) : 'I am not sure.';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-test-${callCount}`,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
          }),
        );
      };

      if (options.delayMs) setTimeout(send, options.delayMs);
      else send();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port, calls: () => callCount });
    });
  });
}

/** Answers the first-party reasoning item correctly so scoring can be checked. */
function correctAnswerFor(prompt: string): string {
  if (prompt.includes('17 脳 39')) return '663';
  if (prompt.includes('taller than')) return 'Charlie';
  if (prompt.includes('chemical symbol for gold')) return 'Au';
  if (prompt.includes('exactly the word "acknowledged"')) return 'acknowledged';
  if (prompt.includes('len("hello")')) return '5';
  if (prompt.includes('{"status":"ok"}')) return '{"status":"ok"}';
  return 'unknown';
}

describe('evaluation engine end-to-end', () => {
  let engine: typeof import('../../server/engine');
  let mappers: typeof import('../../server/db/mappers');
  let seed: typeof import('../../server/db/seed');
  let dbModule: typeof import('../../server/db');
  let provider: Awaited<ReturnType<typeof startFakeProvider>>;

  beforeAll(async () => {
    dbModule = await import('../../server/db');
    dbModule.migrate();
    seed = await import('../../server/db/seed');
    seed.seedRegistry();
    seed.ensureUserSettings();
    engine = await import('../../server/engine');
    mappers = await import('../../server/db/mappers');
    provider = await startFakeProvider({ answer: correctAnswerFor });
  });

  afterAll(async () => {
    if (provider?.server) {
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
    dbModule?.db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function patchProviderBaseUrl(port: number) {
    dbModule.db
      .prepare("UPDATE model_providers SET base_url = ? WHERE id = 'prov-openai-compatible'")
      .run(`http://127.0.0.1:${port}/v1`);
  }

  function createOpenAiCompatibleModel(displayName: string) {
    const id = `model-${displayName.replace(/\W+/g, '-').toLowerCase()}`;
    dbModule.db
      .prepare(
        `INSERT OR REPLACE INTO models
          (id, provider_id, model_id, display_name, known_versions, version_verification, metadata, status, is_demo, created_at, updated_at)
         VALUES (?, 'prov-openai-compatible', ?, ?, '[]', 'unknown', ?, 'registered', 0, ?, ?)`,
      )
      .run(
        id,
        `fake-${displayName}`,
        displayName,
        JSON.stringify({ pricing: { inputPerMillion: 1, outputPerMillion: 2 } }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    return id;
  }

  async function waitForRun(runId: string, timeoutMs = 20000) {
    const started = Date.now();
    for (;;) {
      const run = mappers.getRun(runId);
      if (!run) throw new Error('run disappeared');
      if (!['queued', 'running'].includes(run.status)) return run;
      if (Date.now() - started > timeoutMs) throw new Error(`run did not finish: ${run.status}`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  it('runs a real evaluation against an HTTP provider and persists results', async () => {
    patchProviderBaseUrl(provider.port);
    const modelId = createOpenAiCompatibleModel('Real Provider Model');

    const { id } = engine.createRun({
      modelId,
      itemLimit: 6,
      params: { concurrency: 2, retries: 1, maxTokens: 128 },
    });
    engine.startRun(id);
    const run = await waitForRun(id);

    expect(run.status).toBe('completed');
    expect(run.sampleCount).toBe(6);
    expect(run.successCount).toBeGreaterThan(0);

    // Real per-item rows with raw model output persisted.
    const results = mappers.listResults(id);
    expect(results).toHaveLength(6);
    const scored = results.filter((row) => row.status === 'scored');
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].rawResponse).toBeTruthy();
    expect(scored[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(scored[0].promptTokens).toBe(40);
    expect(scored[0].completionTokens).toBe(12);
    // Cost comes from the pricing metadata, so it must be present and positive.
    expect(scored[0].costUsd).toBeGreaterThan(0);

    // Scores are real aggregates of the item scores, not placeholders. Items are
    // ordered by external_key, so the first N items can belong to any dimension;
    // assert the aggregate for every dimension that actually has items.
    expect(Object.keys(run.scores).length).toBeGreaterThan(0);
    for (const [dimension, score] of Object.entries(run.scores)) {
      const dimensionRows = results.filter((r) => r.dimension === dimension);
      const expected = dimensionRows.reduce((a, r) => a + r.score, 0) / dimensionRows.length;
      expect(score, `dimension ${dimension}`).toBeCloseTo(expected, 3);
    }
    expect(run.overallScore).not.toBeNull();
  });

  it('records a failed run when the provider is unreachable', async () => {
    const modelId = createOpenAiCompatibleModel('Unreachable Provider Model');
    // Port 1 is not listening; the fetch must fail rather than pretend success.
    patchProviderBaseUrl(1);

    const { id } = engine.createRun({
      modelId,
      itemLimit: 2,
      params: { concurrency: 1, retries: 0, timeoutMs: 2500 },
    });
    engine.startRun(id);
    const run = await waitForRun(id);

    expect(['failed', 'partial-failure']).toContain(run.status);
    const results = mappers.listResults(id);
    expect(results.every((row) => row.status !== 'scored')).toBe(true);
    expect(results[0].errorMessage).toBeTruthy();
    patchProviderBaseUrl(provider.port);
  });

  it('retries a rate-limited request and then succeeds', async () => {
    const flaky = await startFakeProvider({ answer: correctAnswerFor, failFirst: 1 });
    patchProviderBaseUrl(flaky.port);
    const modelId = createOpenAiCompatibleModel('Flaky Provider Model');

    const { id } = engine.createRun({
      modelId,
      itemLimit: 2,
      params: { concurrency: 1, retries: 2, maxTokens: 128 },
    });
    engine.startRun(id);
    const run = await waitForRun(id);

    expect(run.successCount + run.failCount).toBe(2);
    // At least one request must have been retried after the 429.
    expect(flaky.calls()).toBeGreaterThan(2);
    await new Promise<void>((resolve) => flaky.server.close(() => resolve()));
    patchProviderBaseUrl(provider.port);
  });

  it('creates regression events from two comparable runs', async () => {
    patchProviderBaseUrl(provider.port);
    const modelId = createOpenAiCompatibleModel('Regression Candidate Model');

    const baseline = engine.createRun({ modelId, itemLimit: 8, params: { concurrency: 2 } });
    engine.startRun(baseline.id);
    await waitForRun(baseline.id);

    // Give SQLite a distinct timestamp ordering for the second run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const comparison = engine.createRun({ modelId, itemLimit: 8, params: { concurrency: 2 } });
    engine.startRun(comparison.id);
    await waitForRun(comparison.id);

    const events = mappers.listRegressionEvents(50).filter((e) => e.modelId === modelId);
    expect(events.length).toBeGreaterThan(0);
    const overall = events.find((e) => e.dimension === null);
    expect(overall).toBeTruthy();
    // Identical answers from the same provider: no significant change expected.
    expect(overall!.conclusion).toBe('no-significant-change');
    expect(overall!.sampleSize).toBeGreaterThan(0);
  });

  it('marks runs with different parameters as not comparable', async () => {
    patchProviderBaseUrl(provider.port);
    const modelId = createOpenAiCompatibleModel('Param Mismatch Model');

    const a = engine.createRun({ modelId, itemLimit: 6, params: { temperature: 0 } });
    engine.startRun(a.id);
    await waitForRun(a.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = engine.createRun({ modelId, itemLimit: 6, params: { temperature: 0.9 } });
    engine.startRun(b.id);
    await waitForRun(b.id);

    const { compareRuns } = await import('../../server/stats/regression');
    const report = compareRuns({ baselineRunId: a.id, comparisonRunId: b.id });
    expect(report.comparable).toBe(false);
    expect(report.comparabilityIssues).toContain('different-temperature');
    expect(report.overall.conclusion).toBe('not-comparable');
  });

  it('is idempotent: the same key never creates two runs', () => {
    const modelId = createOpenAiCompatibleModel('Idempotency Model');
    const key = `idem-${Date.now()}`;
    const first = engine.createRun({ modelId, itemLimit: 2, idempotencyKey: key });
    const second = engine.createRun({ modelId, itemLimit: 2, idempotencyKey: key });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('cancels an active run and marks pending items cancelled', async () => {
    const slow = await startFakeProvider({ answer: correctAnswerFor, delayMs: 900 });
    patchProviderBaseUrl(slow.port);
    const modelId = createOpenAiCompatibleModel('Cancellation Model');

    const { id } = engine.createRun({ modelId, itemLimit: 8, params: { concurrency: 1, timeoutMs: 10000 } });
    engine.startRun(id);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const cancelled = engine.cancelRun(id);
    expect(cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const run = mappers.getRun(id);
    expect(run?.status).toBe('cancelled');
    const results = mappers.listResults(id);
    expect(results.some((row) => row.status === 'cancelled')).toBe(true);

    await new Promise<void>((resolve) => slow.server.close(() => resolve()));
    patchProviderBaseUrl(provider.port);
  });

  it('stops cleanly at the budget cap', async () => {
    patchProviderBaseUrl(provider.port);
    const modelId = createOpenAiCompatibleModel('Tiny Budget Model');
    const { id } = engine.createRun({
      modelId,
      itemLimit: 10,
      params: { concurrency: 1, budgetUsd: 0.000001, maxTokens: 64 },
    });
    engine.startRun(id);
    const run = await waitForRun(id);

    const results = mappers.listResults(id);
    // With a near-zero budget the run must not silently score everything.
    expect(results.filter((r) => r.status === 'scored').length).toBeLessThan(results.length);
    expect(['partial-failure', 'completed']).toContain(run.status);
  });
});
