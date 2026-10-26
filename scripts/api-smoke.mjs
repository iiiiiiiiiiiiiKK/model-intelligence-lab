/**
 * API smoke test — exercises the real HTTP surface against a running server.
 * Usage: node scripts/api-smoke.mjs [baseUrl]
 */
const base = process.argv[2] || 'http://127.0.0.1:8790';

let pass = 0;
let fail = 0;
const failures = [];

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`API smoke test against ${base}\n`);

// health
const health = await req('GET', '/api/health');
check('GET /api/health returns 200', health.status === 200, `status=${health.status}`);
check('health reports database ok', health.json?.services?.database === 'ok');
check('health has version', typeof health.json?.version === 'string');

// overview
const overview = await req('GET', '/api/overview');
check('GET /api/overview returns 200', overview.status === 200);
check(
  'overview counts are numbers',
  typeof overview.json?.counts?.models === 'number' &&
    typeof overview.json?.counts?.benchmarkItems === 'number',
);
check('overview realRuns is 0 on a clean db', overview.json?.counts?.realRuns === 0, `realRuns=${overview.json?.counts?.realRuns}`);
check('overview demo runs are flagged separately', typeof overview.json?.counts?.demoRuns === 'number');

// models
const models = await req('GET', '/api/models');
check('GET /api/models returns 200', models.status === 200);
check('models list is non-empty', Array.isArray(models.json?.models) && models.json.models.length >= 3);
const firstModel = models.json?.models?.[0];
check('model rows expose providerHasCredential', typeof firstModel?.providerHasCredential === 'boolean');
check(
  'model rows never expose a secret field',
  firstModel && !('apiKey' in firstModel) && !('credential' in firstModel) && !('api_key' in firstModel),
);

const modelDetail = await req('GET', `/api/models/${firstModel?.id}`);
check('GET /api/models/:id returns 200', modelDetail.status === 200);
check('model detail has no fabricated scores', modelDetail.json?.model?.scoreSummary?.overall === null);

const missingModel = await req('GET', '/api/models/does-not-exist');
check('unknown model returns 404', missingModel.status === 404);
check('404 uses the uniform error envelope', missingModel.json?.error?.code === 'NOT_FOUND');

// benchmarks
const benchmarks = await req('GET', '/api/benchmarks');
check('GET /api/benchmarks returns 200', benchmarks.status === 200);
const bench = benchmarks.json?.benchmarks?.[0];
check('benchmark has a version', typeof bench?.currentVersion === 'string');
check('benchmark item count >= 100', (bench?.itemCount ?? 0) >= 100, `itemCount=${bench?.itemCount}`);

const benchDetail = await req('GET', '/api/benchmarks/bench-core');
check('benchmark detail returns items', (benchDetail.json?.items?.length ?? 0) >= 100);
check(
  'every item declares a scorer version',
  (benchDetail.json?.items ?? []).every((i) => typeof i.scorer?.version === 'string'),
);
check(
  'items needing a reference have one or a rule config',
  (benchDetail.json?.items ?? []).every(
    (i) => i.reference !== null || Object.keys(i.scorer?.config ?? {}).length > 0,
  ),
);

// evaluation without a configured key must fail loudly, not fake success
const noKeyRun = await req('POST', '/api/evaluations', {
  modelId: firstModel?.id,
  itemLimit: 5,
  idempotencyKey: `smoke-${Date.now()}`,
});
check(
  'creating a run without a provider key is rejected',
  noKeyRun.status === 400 || noKeyRun.status === 402,
  `status=${noKeyRun.status}`,
);
check(
  'the rejection explains the missing credential',
  noKeyRun.json?.error?.code === 'PROVIDER_NOT_CONFIGURED' ||
    noKeyRun.json?.error?.code === 'BUDGET_EXCEEDED',
  noKeyRun.json?.error?.code,
);

// validation
const badRun = await req('POST', '/api/evaluations', { itemLimit: 5 });
check('creating a run without a modelId returns 422', badRun.status === 422, `status=${badRun.status}`);

const badCompare = await req('POST', '/api/regression/compare', {
  baselineRunId: 'a',
  comparisonRunId: 'a',
});
check('comparing a run with itself is rejected', badCompare.status === 400 || badCompare.status === 404);

// settings — a previous test run may have stored a language, so reset first.
await req('PATCH', '/api/settings', { language: 'zh-CN' });
const settings = await req('GET', '/api/settings');
check('GET /api/settings returns 200', settings.status === 200);
check('language can be read back as zh-CN', settings.json?.settings?.language === 'zh-CN');
check(
  'settings expose no credential material',
  !/sk-|api[_-]?key["']?\s*[:=]/i.test(settings.text),
);

const patched = await req('PATCH', '/api/settings', { language: 'en' });
check('PATCH /api/settings updates language', patched.json?.settings?.language === 'en');
await req('PATCH', '/api/settings', { language: 'zh-CN' });

const badSettings = await req('PATCH', '/api/settings', { language: 'fr' });
check('invalid language is rejected', badSettings.status === 422, `status=${badSettings.status}`);

// provider status must never leak keys
const providerStatus = await req('GET', '/api/settings/provider-status');
check(
  'provider status has no key material',
  !/sk-|api[_-]?key["']?\s*[:=]/i.test(providerStatus.text),
);

// reports
const reports = await req('GET', '/api/reports');
check('GET /api/reports returns 200', reports.status === 200);
check('report list does not include access tokens', !/access_token|accessToken/.test(reports.text));

// community
const community = await req('GET', '/api/community');
check('GET /api/community returns 200', community.status === 200);

const submission = await req('POST', '/api/community/submissions', {
  kind: 'item',
  title: 'Smoke test suggestion',
  body: 'A test item submitted by the smoke test.',
  dimension: 'reasoning',
});
check('community submission is accepted', submission.status === 201);
check('new submissions start as pending', submission.json?.submission?.status === 'pending');

const emptySubmission = await req('POST', '/api/community/submissions', { kind: 'item', title: 'x', body: '' });
check('empty submission is rejected', emptySubmission.status === 422);

// regression events
const events = await req('GET', '/api/regression-events');
check('GET /api/regression-events returns 200', events.status === 200);

// rate limit headers
const limited = await fetch(`${base}/api/models`);
check('rate limit headers are present', limited.headers.has('ratelimit') || limited.headers.has('ratelimit-limit'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
