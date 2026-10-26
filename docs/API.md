# API reference

Base URL: `http://127.0.0.1:8790` (dev) — the web client proxies `/api/*` from
`http://127.0.0.1:5199`, and in production the same process serves both.

All responses are JSON. All errors share one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Invalid evaluation payload",
    "details": { "fieldErrors": { "modelId": ["Required"] } },
    "retryable": false
  }
}
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Malformed or contradictory request |
| `VALIDATION_FAILED` | 422 | Zod schema rejection, `details` explains the field |
| `NOT_FOUND` | 404 | Unknown id |
| `FORBIDDEN` | 403 | Missing token, demo-run report, disabled moderation |
| `CONFLICT` | 409 | Duplicate version, run already finished |
| `RATE_LIMITED` | 429 | Too many requests |
| `PROVIDER_NOT_CONFIGURED` | 400 | No server-side key for the provider |
| `PROVIDER_ERROR` | 502 | Upstream provider failure |
| `BUDGET_EXCEEDED` | 402 | Budget cap reached |
| `INTERNAL_ERROR` | 500 | Unexpected failure (message never includes secrets) |

Rate limiting: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS` per IP for all
`/api` routes, with a quarter-sized budget for non-GET requests.

---

## Health

### `GET /api/health`

```json
{
  "status": "degraded",
  "services": {
    "database": "ok",
    "providers": { "DeepSeek": "unconfigured", "OpenAI": "ok" }
  },
  "version": "0.1.0",
  "uptimeSeconds": 42,
  "demoDataPresent": true
}
```

`status` is `ok` only when the database responds *and* at least one provider has a
credential. `degraded` is intentional: the service is up, model calls are not
possible.

---

## Overview

### `GET /api/overview`

Powers the home page. Demo runs are counted separately and never appear in
`recentRuns`, `trend` or `recentEvents`.

```json
{
  "counts": {
    "models": 4, "evaluatedModels": 1, "trackedModels": 1,
    "benchmarks": 1, "benchmarkItems": 128,
    "realRuns": 3, "demoRuns": 1
  },
  "recentRuns": [ /* EvaluationRun[] — real only */ ],
  "recentEvents": [ /* RegressionEvent[] */ ],
  "trend": [{ "modelId": "…", "displayName": "…", "points": [{ "at": "…", "score": 0.81 }] }],
  "dimensionAverages": { "reasoning": 0.78, "coding": 0.72 },
  "providerReadiness": [{ "name": "OpenAI", "kind": "openai", "hasCredential": true }]
}
```

---

## Providers

Provider management lives here now; there is no `.env`-only path.

### `GET /api/providers`

```json
{
  "providers": [{
    "id": "uuid",
    "kind": "openai-compatible",
    "name": "My relay",
    "baseUrl": "https://api.example.com/v1",
    "enabled": true,
    "hasCredential": true,
    "credentialSource": "database",
    "credentialHint": "••••1234",
    "customBaseUrl": true,
    "isBuiltin": false,
    "modelCount": 12,
    "createdAt": "…",
    "updatedAt": "…"
  }],
  "kinds": ["openai", "deepseek", "openai-compatible", "anthropic", "custom"],
  "envFallback": { "openai": false, "deepseek": false, "openai-compatible": false }
}
```

`credentialSource` is `database`, `environment` or `none`. The plaintext key is
never part of this response — only the masked hint.

### `POST /api/providers`

```json
{
  "name": "My relay",
  "kind": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "sk-...",
  "enabled": true
}
```

`201 { provider }`. The base URL is validated by the SSRF guard before saving
(`422` with a hint if it is `http://` without `ALLOW_LOOPBACK_PROVIDER=true`).
A duplicate name returns `409`.

### `PATCH /api/providers/:id`

- Omit `apiKey` to keep the stored one.
- Send `"apiKey": null` to remove it.
- Send a string to replace it.
- Sending `baseUrl` marks the row as explicitly configured, so a later `.env`
  change will not overwrite it.

### `DELETE /api/providers/:id`

`409` when models still reference the provider (history must not be orphaned);
`403` for built-in providers.

### `POST /api/providers/:id/test`

Performs a **real** `GET {baseUrl}/models`. The body may carry a candidate key
that has not been saved yet: `{ "apiKey": "sk-trying-this-before-saving" }`.

```json
{
  "result": {
    "ok": true,
    "status": 200,
    "latencyMs": 56,
    "message": "连接成功，发现 12 个可用模型。",
    "modelCount": 12,
    "sampleModels": ["gpt-4o", "gpt-4o-mini"]
  }
}
```

A failed probe still returns `200` with `ok: false`, so the UI can show the real
reason (401 → bad key, 404 → wrong path) instead of a generic error.

### `GET /api/providers/:id/models`

Lists what the provider reports, marking which ids are already registered:
`{ models: [{ id, registered }], total }`.

### `POST /api/providers/:id/models`

`{ "modelIds": ["gpt-4o", "gpt-4o-mini"] }` → `201 { created, requested }`.
Idempotent — existing pairs are skipped.

### `GET /api/providers/env-status`

`{ variables: [{ kind, name, present }], note }`. Reports variable *names* only.

---

## Catalog

The reference catalog: a curated model list plus third-party reference scores.

### `GET /api/catalog?vendor=&search=&limit=`

`json
{
  "models": [{
    "id": "anthropic/claude-sonnet-5.5",
    "name": "Anthropic: Claude Sonnet 5.5",
    "vendor": "anthropic",
    "contextLength": 1000000,
    "inputPerMillion": 2,
    "outputPerMillion": 10,
    "arenaElo": 1421,
    "arenaCategories": [{ "category": "codecategories", "elo": 1355, "rank": null }],
    "aaIntelligenceIndex": 56,
    "aaCodingIndex": null,
    "aaAgenticIndex": null,
    "inputModalities": ["text", "image"],
    "importedAt": "2026-10-25T22:08:44.521Z",
    "references": [
      { "metric": "arena-elo", "category": "overall", "value": 1421, "unit": "elo", "source": "openrouter", "observedAt": "…" }
    ],
    "registeredModelId": null
  }],
  "vendors": [{ "vendor": "anthropic", "count": 10 }],
  "lastImport": { "importedAt": "…", "status": "ok", "modelsSeen": 128, "message": "…" },
  "source": { "id": "openrouter", "url": "https://openrouter.ai/api/v1/models", "disclaimer": "…" },
  "total": 128
}
`

`registeredModelId` links a catalog row to a locally registered model, so the UI
can offer "register" vs "already registered" without a second request.

### `POST /api/catalog/import`

Performs a real fetch of the upstream directory, rebuilds the curated list and
rewrites the reference scores. Returns `200` with
`{ result: { ok, modelsSeen, modelsNew, scoresWritten, coverage, importedAt, message } }`
on success and `502` with `result.ok === false` on upstream failure. A failed
import is recorded in `external_imports` but never wipes previously imported
data.

### `POST /api/catalog/:catalogId/register`

Body: `{ "providerId": "uuid" }`. Registers the catalog entry as a callable model
on that provider so it can be evaluated with the user's own key. Returns
`201 { created: true, modelId }` or `200 { created: false }` when it already
exists. The catalog id is URL-encoded (it contains `/`).

---

## Models
### `GET /api/models?search=&providerId=&status=`

```json
{
  "models": [{
    "id": "uuid", "providerId": "prov-openai", "providerName": "OpenAI",
    "providerKind": "openai", "providerHasCredential": true,
    "modelId": "gpt-4o-mini", "displayName": "GPT-4o mini",
    "knownVersions": [], "versionVerification": "unknown",
    "metadata": { "pricing": { "inputPerMillion": 0.15, "outputPerMillion": 0.6 } },
    "status": "evaluated", "isDemo": false, "lastEvaluatedAt": "2026-01-01T00:00:00.000Z",
    "runCount": 3, "createdAt": "…", "updatedAt": "…"
  }],
  "total": 4
}
```

### `POST /api/models`

```json
{
  "providerId": "prov-openai-compatible",
  "modelId": "my-gateway-model",
  "displayName": "My gateway model",
  "knownVersions": ["2026-01"],
  "pricing": { "inputPerMillion": 0.5, "outputPerMillion": 1.5 },
  "notes": "internal endpoint"
}
```

Returns `201 { model }`. `pricing` is optional; without it cost is reported as
unknown rather than guessed.

### `GET /api/models/:id`

Returns `{ model: ModelDetail }` with `latestRun`, `scoreSummary`
(`overall`, per-`dimensions`, `sampleSize`) and `history`. With no completed real
runs, `scoreSummary.overall` is `null`.

---

## Benchmarks

### `GET /api/benchmarks?dimension=`

```json
{
  "benchmarks": [{
    "id": "bench-core", "name": "Model Lab Core Benchmark",
    "dimensions": ["reasoning","coding","instruction-following","factuality","stability","behavior"],
    "currentVersionId": "bench-core-v1.0.0", "currentVersion": "1.0.0",
    "itemCount": 128, "versions": [ /* BenchmarkVersion[] */ ]
  }],
  "dimensions": [ … ],
  "scorerTypes": [ … ],
  "datasetMeta": { "source": "model-lab-first-party", "sourceLicense": "CC-BY-4.0", "scorerVersion": "1.1.0" }
}
```

### `GET /api/benchmarks/:id`

`{ benchmark, items: BenchmarkItem[] }` where each item carries `externalKey`,
`dimension`, `question`, `reference`, `scorer { type, version, config }`,
`difficulty`, `source`, `sourceLicense`, `visibility`.

### `POST /api/benchmarks/:id/versions`

Publishes a **new** version. Existing versions are never modified.

```json
{
  "version": "1.1.0",
  "notes": "added 6 coding items",
  "setAsCurrent": true,
  "items": [{
    "externalKey": "cod-101",
    "dimension": "coding",
    "question": "What is the time complexity of binary search?",
    "reference": "O(log n)",
    "scorerType": "normalized-match",
    "scorerConfig": {},
    "difficulty": "easy"
  }]
}
```

`409` if the version string already exists — with a message explaining that
versions are immutable. `422` if a `json-schema` item lacks `scorerConfig.schema`,
a `numeric-tolerance` item lacks a reference, or a `rule-based` item has no rules.

### `POST /api/benchmarks/validate-item`

Dry-run one scorer before publishing:

```json
{
  "scorerType": "numeric-tolerance",
  "scorerConfig": { "tolerance": 0.01 },
  "reference": "42",
  "question": "…",
  "response": "The answer is 42"
}
```

```json
{ "result": { "score": 1, "breakdown": { "strategy": "numeric", "pass": true } }, "passThreshold": 0.75 }
```

---

## Evaluations

### `POST /api/evaluations`

```json
{
  "modelId": "uuid",
  "benchmarkId": "bench-core",
  "itemLimit": 24,
  "idempotencyKey": "client-generated-uuid",
  "params": {
    "temperature": 0,
    "maxTokens": 512,
    "timeoutMs": 60000,
    "retries": 2,
    "concurrency": 3,
    "budgetUsd": 2,
    "systemPrompt": null
  }
}
```

Returns `202 { run, reused: false }`, or `200 { run, reused: true }` when the same
`idempotencyKey` was already used. Params are clamped server-side
(temperature 0–2, maxTokens 16–16384, retries 0–5, concurrency 1–8).

`400 PROVIDER_NOT_CONFIGURED` if the provider has no credential — the run is not
created, so no fake "completed" state can exist.

### `GET /api/evaluations?limit=&modelId=&includeDemo=`

Real runs only by default.

### `GET /api/evaluations/:id`

```json
{
  "run": { /* EvaluationRun with params, modelSnapshot, scores, overallScore, errorSummary */ },
  "progress": { "total": 24, "completed": 24, "failed": 0, "cancelRequested": false, "lastError": null }
}
```

### `GET /api/evaluations/:id/progress`

Lightweight poll target: `{ progress, status }`.

### `GET /api/evaluations/:id/results?dimension=&status=&limit=`

Per-item evidence: `rawResponse`, `normalizedResponse`, `score`,
`scoreBreakdown`, `latencyMs`, `promptTokens`, `completionTokens`, `costUsd`,
`status`, `errorMessage`, `attempts`.

### `POST /api/evaluations/:id/cancel`

`{ cancelled: true, run }`. Already-finished runs return `409`. Scored items are
kept; pending items become `cancelled`.

### `GET /api/evaluations/estimate?items=&maxTokens=`

`{ items, promptTokens, completionTokens, maxItemsPerRun, defaultBudgetUsd, note }`
— explicitly labelled an estimate.

---

## Regression

### `POST /api/regression/compare`

```json
{ "baselineRunId": "uuid", "comparisonRunId": "uuid" }
```

```json
{
  "report": {
    "modelId": "uuid",
    "modelDisplayName": "GPT-4o mini",
    "benchmarkVersion": "1.0.0",
    "comparable": true,
    "comparabilityIssues": [],
    "overall": {
      "dimension": null,
      "baselineScore": 0.8125, "currentScore": 0.7708, "delta": -0.0417,
      "relativeDelta": -0.0513,
      "sampleSize": 24,
      "confidenceInterval": [-0.082, -0.001],
      "statistic": "mcnemar-exact", "statisticValue": null, "pValue": 0.0313,
      "adjustedPValue": null,
      "method": "McNemar exact test on 5 discordant pairs; paired score difference with 95% CI",
      "conclusion": "significant-regression",
      "counts": { "bothCorrect": 16, "baselineOnlyCorrect": 5, "comparisonOnlyCorrect": 0, "bothIncorrect": 3 },
      "baselineInterval": [0.64, 0.91], "currentInterval": [0.58, 0.89]
    },
    "dimensions": [ /* same shape, one row per dimension */ ],
    "eventIds": [],
    "createdAt": "…"
  }
}
```

`comparisonRunId === baselineRunId` → `400`.

### `GET /api/regression/comparability?baselineRunId=&comparisonRunId=`

`{ comparable, issues }` with issue codes such as `different-benchmark-version`,
`different-temperature`, `different-system-prompt`, `different-scorer-version`,
`different-known-versions`, `demo-data`, `run-not-finished`,
`one-or-both-runs-missing`.

### `GET /api/regression/candidates?modelId=`

Finished runs usable as a baseline, newest first.

### `GET /api/regression-events?limit=`

Persisted events. Each carries `conclusion`, `delta`, `sampleSize`,
`confidenceInterval`, `statistic`, `pValue`, `dimension` (`null` = overall).

---

## Compare

### `GET /api/compare?runIds=a,b,c`

```json
{
  "entries": [{
    "runId": "…", "modelDisplayName": "…", "benchmarkVersion": "1.0.0",
    "overallScore": 0.79, "dimensions": { "reasoning": 0.8 },
    "successRate": 0.96, "errorRate": 0.04, "avgLatencyMs": 812,
    "totalCostUsd": 0.0041, "sampleCount": 24,
    "comparable": false, "comparabilityIssues": ["different-temperature"]
  }],
  "items": [{ "itemId": "rsn-001", "dimension": "reasoning", "question": "…",
              "results": { "<runId>": { "score": 1, "status": "scored" } } }],
  "alignmentNotes": ["Runs use different decoding temperatures."]
}
```

### `GET /api/compare/pairwise?baselineRunId=&comparisonRunId=`

Same payload as `POST /api/regression/compare`.

---

## Reports

### `POST /api/reports`

```json
{
  "runId": "uuid",
  "visibility": "private",
  "title": "gpt-4o-mini · 1.0.0",
  "summary": "",
  "language": "zh-CN"
}
```

`201 { report, reused: false }`, or `200 { report, reused: true }` if the run
already has a report. `403` for demo runs. `409` while the run is still active.

### `GET /api/reports`

Never includes `access_token`.

### `GET /api/reports/:publicId?token=`

Public reports need no token. Private reports require `?token=` or
`X-Report-Token`; a missing or wrong token returns `403`.
Response: `{ report, results, shareToken }` (`shareToken` only when private).

### `PATCH /api/reports/:publicId?token=`

Toggles `visibility`, `title`, `summary`. A private report requires its token.

### `GET /api/reports/:publicId/export?token=`

Downloads `model-lab.report.v1` JSON: report metadata, run, per-item evidence and
a disclaimer. No credentials, no request headers, no private benchmark items
beyond the ones already in the run.

---

## Settings

### `GET /api/settings` · `PATCH /api/settings`

```json
{
  "settings": {
    "language": "zh-CN",
    "defaultModelId": null,
    "defaultBenchmarkId": "bench-core",
    "defaultBudgetUsd": 2,
    "reportVisibility": "private",
    "notifications": { "regressionAlerts": true, "runCompleted": true },
    "updatedAt": "…"
  }
}
```

### `GET /api/settings/provider-status`

```json
{
  "providers": [{
    "id": "prov-openai", "name": "OpenAI", "kind": "openai",
    "enabled": true, "hasCredential": true,
    "credentialSource": "OPENAI_API_KEY",
    "baseUrl": "https://api.openai.com/v1"
  }],
  "note": "Credential presence is determined from server environment variables at startup."
}
```

Never returns the key, only the variable *name*.

---

## Community

### `GET /api/community`

`{ submissions: CommunitySubmission[], publicReports: [...] }`

### `POST /api/community/submissions`

```json
{ "kind": "item", "title": "…", "body": "…", "dimension": "reasoning", "reference": "…", "author": "…" }
```

New submissions are always `status: "pending"`; they cannot influence any score
until approved.

### `POST /api/community/submissions/:id/review`

Requires `X-Admin-Token` matching `ADMIN_TOKEN`.

```json
{ "status": "approved", "reviewNote": "verified reference" }
```

Without `ADMIN_TOKEN` configured this endpoint refuses with `403` and says the
moderation path is disabled — it does not silently accept.
