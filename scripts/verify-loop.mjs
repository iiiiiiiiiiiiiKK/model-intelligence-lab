/**
 * Full-loop verification against an isolated database.
 *
 * Boots the real API server against a throwaway SQLite file, points one
 * provider at the local stub (an OpenAI-compatible HTTP server that answers from
 * a rule table), then drives the real HTTP API the way the UI does:
 *
 *   create run -> engine calls the provider -> scoring -> persistence ->
 *   regression analysis -> report -> public share link
 *
 * Because the "model" is a rule table, the resulting scores are NOT a benchmark
 * of any real model. They prove the plumbing works; they say nothing about
 * model quality. The script writes its artefacts to a temp directory and never
 * touches the shipped `data/model-lab.db`.
 *
 * Usage: node scripts/verify-loop.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'model-lab-loop-'));
const dbPath = path.join(tmpDir, 'loop.db');
const API_PORT = 8793;
const STUB_PORT = 8794;
const BASE = `http://127.0.0.1:${API_PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` 鈥?${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` 鈥?${detail}` : ''}`);
  }
}

async function json(method, url, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: response.status, body: parsed, text };
}

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const children = [];

function start(command, args, env, label) {
  const child = spawn(process.execPath, [command, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`    [${label}] ${text.split('\n')[0]}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`    [${label}!] ${text.split('\n')[0]}`);
  });
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  console.log(`Full-loop verification\n  temp db: ${dbPath}\n`);

  // 1. stub provider
  start(path.join(root, 'scripts', 'stub-provider.mjs'), [String(STUB_PORT)], {}, 'stub');
  const stubUp = await waitFor(`http://127.0.0.1:${STUB_PORT}/v1/models`);
  check('stub provider is listening', stubUp);

  // 2. api server on an isolated db, with loopback explicitly allowed
  start(
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    [path.join(root, 'server', 'index.ts')],
    {
      NODE_ENV: 'development',
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      MODEL_LAB_DB_PATH: dbPath,
      OPENAI_COMPATIBLE_API_KEY: 'stub-key-for-loop-verification',
      OPENAI_COMPATIBLE_BASE_URL: '',
      ALLOW_LOOPBACK_PROVIDER: 'true',
      EVAL_MAX_RETRIES: '1',
      EVAL_REQUEST_TIMEOUT_MS: '15000',
      RATE_LIMIT_MAX_REQUESTS: '2000',
    },
    'api',
  );
  const apiUp = await waitFor(`${BASE}/api/health`);
  check('api server is listening', apiUp);
  if (!apiUp) throw new Error('api did not start');

  // 3. point the openai-compatible provider at the stub
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE model_providers SET base_url = ?, name = ? WHERE id = 'prov-openai-compatible'").run(
    `http://127.0.0.1:${STUB_PORT}/v1`,
    'Local stub (verification only)',
  );

  const providerId = 'prov-openai-compatible';
  const modelInsert = await json('POST', '/api/models', {
    providerId,
    modelId: 'stub-model',
    displayName: 'Stub rule-table provider',
    pricing: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  });
  check('registers a model through the API', modelInsert.status === 201, `status ${modelInsert.status}`);
  const modelId = modelInsert.body?.model?.id;
  check('registered model has no fabricated score', modelInsert.body?.model?.scoreSummary?.overall === null);

  // 4. run a real evaluation through the engine
  console.log('\n  creating evaluation (24 items)...');
  const created = await json('POST', '/api/evaluations', {
    modelId,
    itemLimit: 24,
    idempotencyKey: `loop-${Date.now()}`,
    params: { temperature: 0, maxTokens: 128, retries: 1, concurrency: 2, budgetUsd: 1 },
  });
  check('evaluation is accepted', [200, 202].includes(created.status), `status ${created.status}`);
  const runId = created.body?.run?.id;
  check('run id returned', typeof runId === 'string');

  // poll until it finishes
  let run = null;
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const detail = await json('GET', `/api/evaluations/${runId}`);
    run = detail.body?.run;
    if (run && !['queued', 'running'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  check('run reaches a terminal state', run && !['queued', 'running'].includes(run.status), run?.status);
  check('run completed without failures', run?.status === 'completed', run?.status);
  check('items were actually scored', run?.successCount === 24, `successCount ${run?.successCount}`);

  const results = await json('GET', `/api/evaluations/${runId}/results`);
  const rows = results.body?.results ?? [];
  check('per-item results persisted', rows.length === 24, `${rows.length} rows`);
  check(
    'raw model output was stored verbatim',
    rows.every((row) => typeof row.rawResponse === 'string' && row.rawResponse.length > 0),
  );
  check(
    'token usage was recorded from the provider response',
    rows.every((row) => row.promptTokens === 90 && row.completionTokens === 25),
  );
  check(
    'latency was measured per item',
    rows.every((row) => typeof row.latencyMs === 'number' && row.latencyMs >= 0),
  );
  check(
    'estimated cost was computed from pricing metadata',
    rows.some((row) => typeof row.costUsd === 'number' && row.costUsd > 0),
  );
  check(
    'scoring breakdown records the scorer version',
    rows.every((row) => row.scoreBreakdown?.scorerVersion),
  );

  const scores = rows.filter((row) => row.status === 'scored').map((row) => row.score);
  check('scores are in [0,1]', scores.every((value) => value >= 0 && value <= 1));
  check('the rule-table answers score some items correct', scores.some((value) => value >= 0.75));
  // The point of this assertion is that scoring discriminates rather than awarding 1.0 wholesale.
  check('scoring is discriminating, not a blanket pass', scores.some((value) => value < 1));
  check(
    'every dimension score is a real aggregate',
    Object.values(run?.scores ?? {}).every((value) => typeof value === 'number' && value >= 0 && value <= 1),
  );

  // 5. second run + regression analysis
  console.log('\n  creating a second evaluation for regression analysis...');
  const second = await json('POST', '/api/evaluations', {
    modelId,
    itemLimit: 24,
    idempotencyKey: `loop2-${Date.now()}`,
    params: { temperature: 0, maxTokens: 128, retries: 1, concurrency: 2, budgetUsd: 1 },
  });
  const secondId = second.body?.run?.id;
  const started2 = Date.now();
  let secondRun = null;
  while (Date.now() - started2 < 60000) {
    const detail = await json('GET', `/api/evaluations/${secondId}`);
    secondRun = detail.body?.run;
    if (secondRun && !['queued', 'running'].includes(secondRun.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  check('second run completed', secondRun?.status === 'completed', secondRun?.status);

  const comparison = await json('POST', '/api/regression/compare', {
    baselineRunId: runId,
    comparisonRunId: secondId,
  });
  check('regression comparison succeeds', comparison.status === 200, `status ${comparison.status}`);
  const report = comparison.body?.report;
  check('comparison reports comparability', report?.comparable === true, JSON.stringify(report?.comparabilityIssues));
  check(
    'identical conditions yield "no significant change"',
    report?.overall?.conclusion === 'no-significant-change',
    report?.overall?.conclusion,
  );
  check('comparison includes the paired counts', typeof report?.overall?.counts === 'object');
  check('comparison states the statistical method', typeof report?.overall?.method === 'string');

  // 6. differing parameters must block a regression verdict
  const third = await json('POST', '/api/evaluations', {
    modelId,
    itemLimit: 24,
    idempotencyKey: `loop3-${Date.now()}`,
    params: { temperature: 1.1, maxTokens: 128, retries: 1, concurrency: 2, budgetUsd: 1 },
  });
  const thirdId = third.body?.run?.id;
  const started3 = Date.now();
  while (Date.now() - started3 < 60000) {
    const detail = await json('GET', `/api/evaluations/${thirdId}`);
    if (detail.body?.run && !['queued', 'running'].includes(detail.body.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const mismatched = await json('POST', '/api/regression/compare', {
    baselineRunId: runId,
    comparisonRunId: thirdId,
  });
  check('parameter mismatch is detected', mismatched.body?.report?.comparable === false);
  check(
    'parameter mismatch downgrades the conclusion',
    mismatched.body?.report?.overall?.conclusion === 'not-comparable',
    mismatched.body?.report?.overall?.conclusion,
  );

  // 7. report + share link
  const reportResponse = await json('POST', '/api/reports', {
    runId,
    visibility: 'public',
    title: 'Loop verification report',
    summary: 'Generated by scripts/verify-loop.mjs against a local stub provider.',
    language: 'en',
  });
  check('report is created', reportResponse.status === 201, `status ${reportResponse.status}`);
  const publicId = reportResponse.body?.report?.publicId;

  const publicReport = await json('GET', `/api/reports/${publicId}`);
  check('public report is readable without a token', publicReport.status === 200);
  check('public report carries the run', publicReport.body?.report?.run?.id === runId);
  check(
    'public report contains no key material',
    !/stub-key-for-loop-verification/.test(JSON.stringify(publicReport.body)),
  );

  const exportResponse = await fetch(`${BASE}/api/reports/${publicId}/export`);
  const exported = await exportResponse.json();
  check('report export works', exportResponse.ok);
  check('export includes a disclaimer', typeof exported.disclaimer === 'string');

  // 8. cannot start a run without a credential
  db.prepare("INSERT OR REPLACE INTO models (id, provider_id, model_id, display_name, known_versions, version_verification, metadata, status, is_demo, created_at, updated_at) VALUES ('nokey-model', 'prov-deepseek', 'deepseek-chat', 'No-key model', '[]', 'unknown', '{}', 'registered', 0, datetime('now'), datetime('now'))").run();
  const noKey = await json('POST', '/api/evaluations', { modelId: 'nokey-model', itemLimit: 2 });
  check('run without credential is rejected', noKey.status === 400, `status ${noKey.status}`);
  check('rejection names the missing credential', noKey.body?.error?.code === 'PROVIDER_NOT_CONFIGURED');

  // 9. overview reflects the real runs
  const overview = await json('GET', '/api/overview');
  check('overview counts the real runs', overview.body?.counts?.realRuns === 3, `realRuns ${overview.body?.counts?.realRuns}`);
  check('overview leaves demo runs separate', overview.body?.counts?.demoRuns === 0, `demoRuns ${overview.body?.counts?.demoRuns}`);
  check(
    'overview never lists demo runs among real ones',
    (overview.body?.recentRuns ?? []).every((entry) => entry.isDemo === false),
  );

  db.close();
} catch (error) {
  fail += 1;
  failures.push(`unexpected error: ${error.message}`);
  console.log(`  FAIL  unexpected error 鈥?${error.message}`);
} finally {
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(fail === 0 ? 0 : 1);
