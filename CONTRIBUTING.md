# Contributing

Thanks for considering a contribution. This project has one hard rule that
overrides everything else:

> **Never present unverified work as verified.** If a test was not run, say so.
> If a provider was not called, say so. If a score is synthetic, label it.

## Setup

```bash
npm install
npm run db:seed          # schema + model registry + demo data
npm run dev              # API on :8790, web on :5199
```

Open <http://127.0.0.1:5199>. Demo data is badged and excluded from analytics, so
you can explore the UI before configuring a provider key.

## The gate

```bash
npm run verify
```

That is typecheck (app + server + tests), lint (zero warnings allowed), the full
vitest suite, and the production build. A change is not ready until it passes.

```bash
npm run test:e2e         # Playwright, desktop + mobile
node scripts/verify-loop.mjs   # full engine loop against a local stub provider
```

## Adding a benchmark item

Items live in `server/benchmarks/dataset.ts`. Every item must be gradeable
deterministically:

| Requirement | Why |
| --- | --- |
| Unique `key` (e.g. `rsn-027`) | Stable identity for paired comparison |
| One of the six dimensions | Dimension scores are the primary signal |
| A `reference` answer **or** an explicit `scorerConfig` | Otherwise scoring is guesswork |
| A scorer that matches the answer shape | `numeric-tolerance` needs a number, `json-schema` needs a schema |
| Honest `difficulty` and `source` | Reports show them |

Guidelines:

- Prefer an exact, checkable answer over a subjective one.
- If multiple answers are valid (e.g. "name a prime between 10 and 20"), use a
  `rule-based` scorer with a regex — do not pretend one answer is the only truth.
- If an item would need code execution, mark it `unit-test`; it will be graded
  structurally and the UI says so.
- Do not add items whose answer depends on knowledge after your model's training
  cutoff unless you intend to measure that specifically and say so.

Publishing always creates a **new version** — existing versions are immutable, so
historical runs keep their meaning. Test your change with:

```bash
npx vitest run tests/unit/security.test.ts   # dataset integrity checks
```

## Adding a scorer

1. Implement a `ScorerFn` in `server/scoring/index.ts`:

   ```ts
   const myScorer: ScorerFn = ({ question, reference, response, scorer }) => ({
     score: 0.0,                       // must be in [0, 1]
     normalized: response.trim(),
     breakdown: { strategy: 'my-scorer', /* evidence */ },
   });
   ```

2. Register it in `REGISTRY`.
3. Add the type to `ScorerType` in `shared/types.ts`.
4. Add a label in `src/i18n/zh.ts` **and** `src/i18n/en.ts` (`scorer.<type>`).
5. Add unit tests in `tests/unit/scoring.test.ts`, including the failure paths.

Scorers must be pure and must never execute model output.

## Adding a provider

Add a `ChatTransport` in `server/providers/index.ts` and map it in `TRANSPORTS`.
The transport receives `{ baseUrl, apiKey, modelId, messages, temperature,
maxTokens, timeoutMs, signal }` and must return
`{ text, providerResponseId, promptTokens, completionTokens, latencyMs, raw }`.

Rules:

- Throw `AdapterError` with a correct `kind` (`timeout`, `auth`, `rate-limit`,
  `server`, `network`, `bad-response`) — retry behaviour depends on it.
- Return `null` for token counts the provider does not report. Never invent them.
- Do not log the request body or headers; they contain the key.

## Adding a translation

Both catalogues must stay in lockstep. `src/i18n/en.ts` is typed as
`Record<keyof typeof zh, string>`, so a missing key is a compile error, and
`tests/components/i18n.test.tsx` asserts key-set parity at runtime.

- Model ids, code, hashes and raw model output are **not** translated.
- Dates, numbers and percentages go through `src/lib/format.ts` (`Intl`).

## Style

- TypeScript strict; no `any` in new code without a comment explaining why.
- Server errors: throw `ApiError` with the narrowest code; never leak internals.
- Never write a secret into the database, a log line, a report or a test fixture.
  The tests use obviously-fake values like `test-key-not-a-real-secret`.
- Keep route handlers thin: validation in the router, logic in a domain module.
- New UI states must cover loading, empty, error and (where relevant) disabled.

## Reporting an evaluation bug

Include:

1. The run id (`GET /api/evaluations/:id`).
2. The benchmark version and the parameters from `run.params`.
3. What you expected versus the per-item evidence (`/results`).
4. Your Node version and OS.

Please do not include API keys, raw provider headers or private report tokens in
an issue.
