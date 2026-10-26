/**
 * Seeding.
 *
 * Two clearly separated layers:
 *   1. `seedRegistry` — real, non-fabricated reference data: provider records,
 *      a model registry (models that *exist* on the provider, with no scores)
 *      and the first-party benchmark dataset with a version row per release.
 *   2. `seedDemoData` — optional, explicitly opt-in sample runs marked
 *      `is_demo = 1` so the UI can badge them as Demo and exclude them from
 *      regression events and rankings.
 */
import { db, migrate, newId, nowIso } from './index';
import { CORE_DATASET, CORE_DATASET_META } from '../benchmarks/dataset';
import { MODEL_CATALOG, CATALOG_SOURCE } from '../benchmarks/model-catalog';
import { env } from '../config';
import type { BenchmarkDimension } from '../../shared/types';
import { DIMENSIONS } from '../../shared/constants';

export interface SeedResult {
  providers: number;
  models: number;
  benchmarks: number;
  items: number;
  created: boolean;
}

const PROVIDERS = [
  {
    key: 'openai',
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    key: 'deepseek',
    kind: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
  },
  {
    key: 'openai-compatible',
    kind: 'openai-compatible',
    name: 'OpenAI-compatible gateway',
    baseUrl: 'https://api.openai.com/v1',
  },
] as const;

/**
 * Registry of models known to exist on each provider. `metadata.pricing` holds
 * published list prices in USD per 1M tokens; when a provider changes pricing,
 * update the value here and the change is visible in git history. Costs in the
 * UI are always labelled "estimated" because the provider's own bill wins.
 */
const MODEL_REGISTRY: Array<{
  providerKey: string;
  modelId: string;
  displayName: string;
  knownVersions: string[];
  versionVerification: 'verified' | 'unverified' | 'unknown';
  pricing: { inputPerMillion: number | null; outputPerMillion: number | null };
  notes: string;
}> = [
  {
    providerKey: 'openai',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    knownVersions: [],
    versionVerification: 'unknown',
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    notes: 'OpenAI does not publish a stable snapshot identifier for every alias.',
  },
  {
    providerKey: 'openai',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    knownVersions: [],
    versionVerification: 'unknown',
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    notes: 'Alias may be repointed by the provider; treat version as unverified.',
  },
  {
    providerKey: 'deepseek',
    modelId: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    knownVersions: [],
    versionVerification: 'unknown',
    pricing: { inputPerMillion: 0.27, outputPerMillion: 1.1 },
    notes: 'Points at the current V-series chat model; underlying snapshot is not exposed.',
  },
  {
    providerKey: 'deepseek',
    modelId: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    knownVersions: [],
    versionVerification: 'unknown',
    pricing: { inputPerMillion: 0.55, outputPerMillion: 2.19 },
    notes: 'Reasoning variant; deterministic temperature is ignored by some deployments.',
  },
];

function providerCredential(providerKey: string): boolean {
  if (providerKey === 'openai') return Boolean(env.OPENAI_API_KEY);
  if (providerKey === 'deepseek') return Boolean(env.DEEPSEEK_API_KEY);
  if (providerKey === 'openai-compatible') return Boolean(env.OPENAI_COMPATIBLE_API_KEY);
  return false;
}

export function seedRegistry(): SeedResult {
  migrate();
  const now = nowIso();

  let providers = 0;
  for (const provider of PROVIDERS) {
    const existing = db
      .prepare('SELECT id FROM model_providers WHERE id = ?')
      .get(`prov-${provider.key}`) as { id: string } | undefined;
    if (existing) continue;
    db.prepare(
      `INSERT INTO model_providers (id, kind, name, base_url, enabled, config, has_credential, base_url_override, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, 0, 1, ?, ?)`,
    ).run(
      `prov-${provider.key}`,
      provider.kind,
      provider.name,
      provider.baseUrl,
      JSON.stringify({ registryKey: provider.key }),
      providerCredential(provider.key) ? 1 : 0,
      now,
      now,
    );
    providers += 1;
  }

  let models = 0;
  for (const entry of MODEL_REGISTRY) {
    const providerRow = db
      .prepare('SELECT id, base_url FROM model_providers WHERE id = ?')
      .get(`prov-${entry.providerKey}`) as { id: string; base_url: string } | undefined;
    if (!providerRow) continue;
    const existing = db
      .prepare('SELECT id FROM models WHERE provider_id = ? AND model_id = ?')
      .get(providerRow.id, entry.modelId) as { id: string } | undefined;
    if (existing) continue;
    db.prepare(
      `INSERT INTO models (id, provider_id, model_id, display_name, known_versions, version_verification, metadata, status, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', 0, ?, ?)`,
    ).run(
      newId(),
      providerRow.id,
      entry.modelId,
      entry.displayName,
      JSON.stringify(entry.knownVersions),
      entry.versionVerification,
      JSON.stringify({ pricing: entry.pricing, notes: entry.notes }),
      now,
      now,
    );
    models += 1;
  }

  // The generated catalog is provided as reference data on the generic gateway
  // provider, so a fresh install already lists the mainstream models instead of
  // four hand-written rows. They start as "registered" (never "evaluated"): no
  // score exists until someone runs an evaluation with their own key.
  const gateway = db
    .prepare('SELECT id FROM model_providers WHERE id = ?')
    .get('prov-openai-compatible') as { id: string } | undefined;

  if (gateway) {
    const insertCatalog = db.prepare(
      `INSERT INTO models (id, provider_id, model_id, display_name, known_versions, version_verification, metadata, status, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 'unknown', ?, 'registered', 0, ?, ?)
       ON CONFLICT(provider_id, model_id) DO NOTHING`,
    );
    for (const entry of MODEL_CATALOG) {
      const changes = insertCatalog.run(
        newId(),
        gateway.id,
        entry.modelId,
        entry.displayName,
        JSON.stringify({
          pricing: {
            inputPerMillion: entry.inputPerMillion,
            outputPerMillion: entry.outputPerMillion,
          },
          vendor: entry.vendor,
          contextLength: entry.contextLength,
          inputModalities: entry.inputModalities,
          catalogSource: CATALOG_SOURCE.id,
          catalogObservedAt: CATALOG_SOURCE.observedAt,
        }),
        now,
        now,
      ).changes;
      models += Number(changes ?? 0);
    }
  }

  const created = seedCoreBenchmark();
  return {
    providers,
    models,
    benchmarks: created ? 1 : 0,
    items: created ? CORE_DATASET.length : 0,
    created,
  };
}

/** Inserts the first-party benchmark if not present. Never overwrites versions. */
function seedCoreBenchmark(): boolean {
  const now = nowIso();
  const benchmarkId = CORE_DATASET_META.id;
  const existing = db.prepare('SELECT id FROM benchmarks WHERE id = ?').get(benchmarkId) as
    | { id: string }
    | undefined;
  if (existing) return false;

  const versionId = `${benchmarkId}-v${CORE_DATASET_META.version}`;
  const hash = contentHash();

  db.prepare(
    `INSERT INTO benchmarks (id, name, description, visibility, dimensions, current_version_id, is_demo, created_at, updated_at)
     VALUES (?, ?, ?, 'public', ?, ?, 0, ?, ?)`,
  ).run(
    benchmarkId,
    CORE_DATASET_META.name,
    CORE_DATASET_META.description,
    JSON.stringify(DIMENSIONS),
    versionId,
    now,
    now,
  );

  db.prepare(
    `INSERT INTO benchmark_versions (id, benchmark_id, version, content_hash, scorer_version, published, item_count, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    versionId,
    benchmarkId,
    CORE_DATASET_META.version,
    hash,
    CORE_DATASET_META.scorerVersion,
    CORE_DATASET.length,
    'Initial first-party release. Scorers are deterministic; unit-test items are graded structurally.',
    now,
  );

  const insert = db.prepare(
    `INSERT INTO benchmark_items
      (id, benchmark_version_id, external_key, dimension, question, reference, scorer_type, scorer_version, scorer_config, difficulty, source, source_license, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?)`,
  );

  for (const entry of CORE_DATASET) {
    insert.run(
      newId(),
      versionId,
      entry.key,
      entry.dimension,
      entry.question,
      entry.reference,
      entry.scorerType,
      CORE_DATASET_META.scorerVersion,
      JSON.stringify(entry.scorerConfig),
      entry.difficulty,
      CORE_DATASET_META.source,
      CORE_DATASET_META.sourceLicense,
      now,
      now,
    );
  }

  return true;
}

function contentHash(): string {
  const payload = CORE_DATASET.map((i) => `${i.key}|${i.dimension}|${i.question}|${i.reference}|${i.scorerType}`).join('\n');
  // Deterministic FNV-1a based hash; enough for change detection, not security.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i);
    h1 = (h1 ^ code) * 0x01000193;
    h2 = (h2 + code * (i + 1)) >>> 0;
  }
  const a = (h1 >>> 0).toString(16).padStart(8, '0');
  const b = (h2 >>> 0).toString(16).padStart(8, '0');
  return `sha256-sim:${a}${b}`;
}

/**
 * Optional demo data. Every row is flagged `is_demo = 1` and the run notes say
 * so explicitly. Demo rows never create regression events and are excluded from
 * "tracked" model counts.
 */
export function seedDemoData(): { runs: number; reports: number } {
  migrate();
  const now = nowIso();

  // Demo benchmark version at v1.0.0 of bench-core is used so comparisons stay
  // honest, but the demo *runs* are marked and excluded from analytics.
  const version = db
    .prepare('SELECT id, version FROM benchmark_versions WHERE benchmark_id = ? ORDER BY version DESC LIMIT 1')
    .get(CORE_DATASET_META.id) as { id: string; version: string } | undefined;
  if (!version) throw new Error('Seed the registry before demo data.');

  const items = db
    .prepare(
      `SELECT id, external_key, dimension, reference, scorer_type FROM benchmark_items
       WHERE benchmark_version_id = ? ORDER BY external_key LIMIT 20`,
    )
    .all(version.id) as Array<{
    id: string;
    external_key: string;
    dimension: BenchmarkDimension;
    reference: string | null;
    scorer_type: string;
  }>;

  const model = db
    .prepare("SELECT id, display_name FROM models WHERE model_id = 'deepseek-chat' LIMIT 1")
    .get() as { id: string; display_name: string } | undefined;
  if (!model) throw new Error('Seed the registry before demo data.');

  const existingDemo = db
    .prepare('SELECT id FROM evaluation_runs WHERE is_demo = 1 LIMIT 1')
    .get() as { id: string } | undefined;
  if (existingDemo) {
    return { runs: 0, reports: 0 };
  }

  const insertRun = db.prepare(
    `INSERT INTO evaluation_runs
      (id, idempotency_key, model_id, benchmark_id, benchmark_version_id, status, params, model_snapshot,
       sample_count, success_count, fail_count, timeout_count, scores, total_latency_ms, total_tokens,
       estimated_cost_usd, actual_cost_usd, error_summary, cancel_requested, is_demo, notes, created_at, updated_at, completed_at)
     VALUES (?, NULL, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?, ?, ?)`,
  );

  const insertResult = db.prepare(
    `INSERT INTO evaluation_results
      (id, run_id, item_id, dimension, raw_response, normalized_response, score, score_breakdown,
       latency_ms, prompt_tokens, completion_tokens, cost_usd, status, error_message, provider_response_id, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?)`,
  );

  const params = JSON.stringify({
    temperature: 0,
    maxTokens: 1024,
    timeoutMs: 60000,
    retries: 2,
    concurrency: 3,
    budgetUsd: 2,
    systemPrompt: null,
  });

  const snapshot = JSON.stringify({
    modelId: 'deepseek-chat',
    providerId: 'prov-deepseek',
    providerKind: 'deepseek',
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelDbId: model.id,
    displayName: model.display_name,
    knownVersions: [],
    versionVerification: 'unknown',
    demo: true,
  });

  const runId = newId();
  const created = new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString();

  let success = 0;
  let fail = 0;

  insertRun.run(
    runId,
    model.id,
    CORE_DATASET_META.id,
    version.id,
    params,
    snapshot,
    items.length,
    0,
    0,
    0,
    '{}',
    0,
    0,
    0,
    null,
    'DEMO DATA — generated sample run, not a real model call. Excluded from analytics and regression detection.',
    created,
    created,
    created,
  );

  for (const [index, item] of items.entries()) {
    // Deterministic pseudo-outcome so demo data is stable across machines.
    const correct = item.reference !== null && index % 3 !== 2;
    const score = correct ? 1 : 0;
    if (correct) success += 1;
    else fail += 1;
    insertResult.run(
      newId(),
      runId,
      item.id,
      item.dimension,
      correct ? (item.reference ?? 'demo-response') : 'DEMO incorrect response',
      correct ? (item.reference ?? 'demo-response') : 'demo incorrect response',
      score,
      JSON.stringify({ strategy: 'demo', demo: true, note: 'Synthetic demo outcome, no model call made.' }),
      240 + index * 7,
      120,
      40,
      0,
      'scored',
      created,
    );
  }

  const dimensionScores: Record<string, number> = {};
  const rows = db
    .prepare('SELECT dimension, AVG(score) AS s FROM evaluation_results WHERE run_id = ? GROUP BY dimension')
    .all(runId) as Array<{ dimension: string; s: number }>;
  for (const row of rows) dimensionScores[row.dimension] = Number(row.s.toFixed(4));

  db.prepare(
    `UPDATE evaluation_runs SET success_count = ?, fail_count = ?, scores = ?, total_latency_ms = ?, total_tokens = ? WHERE id = ?`,
  ).run(
    success,
    fail,
    JSON.stringify(dimensionScores),
    items.length * 240,
    items.length * 160,
    runId,
  );

  db.prepare(
    `INSERT INTO reports (id, public_id, run_id, visibility, title, summary, language, access_token, created_at)
     VALUES (?, ?, ?, 'private', ?, ?, 'zh-CN', ?, ?)`,
  ).run(
    newId(),
    `rpt_demo_${runId.slice(0, 8)}`,
    runId,
    '[DEMO] 示例评测报告',
    'This report is generated from demo data. It shows the report layout only and must not be read as a real model evaluation.',
    newId(),
    now,
  );

  return { runs: 1, reports: 1 };
}

export function ensureUserSettings(): void {
  migrate();
  const existing = db.prepare('SELECT id FROM user_settings LIMIT 1').get() as { id: string } | undefined;
  if (existing) return;
  const now = nowIso();
  db.prepare(
    `INSERT INTO user_settings (id, language, default_model_id, default_benchmark_id, default_budget_usd, report_visibility, notifications, created_at, updated_at)
     VALUES (?, 'zh-CN', NULL, ?, ?, 'private', ?, ?, ?)`,
  ).run(
    newId(),
    CORE_DATASET_META.id,
    env.EVAL_DEFAULT_BUDGET_USD,
    JSON.stringify({ regressionAlerts: true, runCompleted: true }),
    now,
    now,
  );
}
