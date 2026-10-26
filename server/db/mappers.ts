/**
 * Read-model mappers: SQL rows -> shared API types.
 * Keeping the mapping in one place means the client never sees raw snake_case
 * rows and secret-adjacent columns are structurally impossible to leak.
 */
import { getRow, getRows, parseJson, db } from './index';
import { resolveCredentialForProvider, type ResolvedCredential } from '../credentials';
import type {
  Benchmark,
  BenchmarkDimension,
  BenchmarkItem,
  BenchmarkVersion,
  EvaluationParams,
  EvaluationResult,
  EvaluationRun,
  EvaluationStatus,
  Model,
  ModelDetail,
  ModelSnapshot,
  ModelStatus,
  ProviderKind,
  ProviderSummary,
  RegressionEvent,
  RegressionConclusion,
  Report,
  UserSettings,
  ScorerType,
  VersionVerification,
  Locale,
  ReportVisibility,
} from '../../shared/types';
import { computeOverall } from '../../shared/aggregate';

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

interface ProviderRow {
  id: string;
  kind: string;
  name: string;
  base_url: string;
  enabled: number;
  config: string;
  has_credential: number;
  api_key_ciphertext: string | null;
  api_key_hint: string | null;
  base_url_override: number;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export function mapProvider(row: ProviderRow, credential?: ResolvedCredential, modelCount = 0): ProviderSummary {
  const resolved = credential ?? resolveCredentialForProvider(row.id);
  return {
    id: row.id,
    kind: row.kind as ProviderKind,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    hasCredential: Boolean(resolved.value),
    credentialSource: resolved.source,
    credentialHint: resolved.hint,
    customBaseUrl: row.base_url_override === 1,
    isBuiltin: row.is_builtin === 1,
    modelCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProviders(): ProviderSummary[] {
  const counts = new Map(
    getRows<{ provider_id: string; c: number }>(
      'SELECT provider_id, COUNT(*) AS c FROM models GROUP BY provider_id',
    ).map((row) => [row.provider_id, Number(row.c)]),
  );
  return getRows<ProviderRow>('SELECT * FROM model_providers ORDER BY is_builtin DESC, name').map((row) =>
    mapProvider(row, undefined, counts.get(row.id) ?? 0),
  );
}

export function getProvider(id: string): ProviderSummary | null {
  const row = getRow<ProviderRow>('SELECT * FROM model_providers WHERE id = ?', id);
  return row ? mapProvider(row) : null;
}

/**
 * Keeps the cached `has_credential` flag in step with the real credential
 * resolution, so the UI never claims a key exists when it does not.
 */
export function refreshProviderCredentialFlags(check?: (kind: string) => boolean): void {
  for (const row of getRows<ProviderRow>('SELECT * FROM model_providers')) {
    const has = check ? check(row.kind) : Boolean(resolveCredentialForProvider(row.id).value);
    const next = has ? 1 : 0;
    if (next !== row.has_credential) {
      db.prepare('UPDATE model_providers SET has_credential = ?, updated_at = ? WHERE id = ?').run(
        next,
        new Date().toISOString(),
        row.id,
      );
    }
  }
}

/**
 * Applies `*_BASE_URL` environment values to provider rows that have no explicit
 * override. A URL saved from the UI wins, so a later deploy of `.env` cannot
 * silently redirect traffic the user configured in the browser.
 */
export function syncProviderBaseUrlsFromEnv(resolve: (kind: string, current: string) => string): number {
  let updated = 0;
  for (const row of getRows<ProviderRow>(
    'SELECT * FROM model_providers WHERE base_url_override = 0',
  )) {
    const next = resolve(row.kind, row.base_url);
    if (!next || next === row.base_url) continue;
    db.prepare('UPDATE model_providers SET base_url = ?, updated_at = ? WHERE id = ?').run(
      next,
      new Date().toISOString(),
      row.id,
    );
    updated += 1;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  known_versions: string;
  version_verification: string;
  metadata: string;
  status: string;
  is_demo: number;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
  provider_name: string;
  provider_kind: string;
  provider_has_credential: number;
  run_count: number;
}

const MODEL_SELECT = `
SELECT m.*, p.name AS provider_name, p.kind AS provider_kind, p.has_credential AS provider_has_credential,
  (SELECT COUNT(*) FROM evaluation_runs r WHERE r.model_id = m.id AND r.is_demo = 0 AND r.status IN ('completed','partial-failure')) AS run_count
FROM models m
JOIN model_providers p ON p.id = m.provider_id
`;

export function mapModel(row: ModelRow): Model {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerKind: row.provider_kind as ProviderKind,
    providerHasCredential: row.provider_has_credential === 1,
    modelId: row.model_id,
    displayName: row.display_name,
    knownVersions: parseJson<string[]>(row.known_versions, []),
    versionVerification: row.version_verification as VersionVerification,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    status: row.status as ModelStatus,
    isDemo: row.is_demo === 1,
    lastEvaluatedAt: row.last_evaluated_at,
    runCount: Number(row.run_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listModels(): Model[] {
  return getRows<ModelRow>(`${MODEL_SELECT} ORDER BY m.display_name`).map(mapModel);
}

export function getModelRow(id: string): Model | null {
  const row = getRow<ModelRow>(`${MODEL_SELECT} WHERE m.id = ?`, id);
  return row ? mapModel(row) : null;
}

export function getModelByProviderModelId(providerId: string, modelId: string): Model | null {
  const row = getRow<ModelRow>(`${MODEL_SELECT} WHERE m.provider_id = ? AND m.model_id = ?`, providerId, modelId);
  return row ? mapModel(row) : null;
}

// ---------------------------------------------------------------------------
// benchmarks
// ---------------------------------------------------------------------------

interface BenchmarkRow {
  id: string;
  name: string;
  description: string;
  visibility: string;
  dimensions: string;
  current_version_id: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  benchmark_id: string;
  version: string;
  content_hash: string;
  scorer_version: string;
  published: number;
  item_count: number;
  notes: string;
  created_at: string;
}

interface ItemRow {
  id: string;
  benchmark_version_id: string;
  external_key: string;
  dimension: string;
  question: string;
  reference: string | null;
  scorer_type: string;
  scorer_version: string;
  scorer_config: string;
  difficulty: string;
  source: string;
  source_license: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export function mapItem(row: ItemRow): BenchmarkItem {
  return {
    id: row.id,
    externalKey: row.external_key,
    dimension: row.dimension as BenchmarkDimension,
    question: row.question,
    reference: row.reference,
    scorer: {
      type: row.scorer_type as ScorerType,
      version: row.scorer_version,
      config: parseJson<Record<string, unknown>>(row.scorer_config, {}),
    },
    difficulty: row.difficulty as 'easy' | 'medium' | 'hard',
    source: row.source,
    sourceLicense: row.source_license,
    visibility: row.visibility as 'public' | 'private',
  };
}

function dimensionCounts(versionId: string): Record<string, number> {
  const rows = getRows<{ dimension: string; c: number }>(
    'SELECT dimension, COUNT(*) AS c FROM benchmark_items WHERE benchmark_version_id = ? GROUP BY dimension',
    versionId,
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.dimension] = Number(row.c);
  return out;
}

export function mapVersion(row: VersionRow): BenchmarkVersion {
  return {
    id: row.id,
    benchmarkId: row.benchmark_id,
    version: row.version,
    contentHash: row.content_hash,
    scorerVersion: row.scorer_version,
    published: row.published === 1,
    itemCount: Number(row.item_count),
    notes: row.notes,
    createdAt: row.created_at,
    dimensionCounts: dimensionCounts(row.id),
  };
}

export function listBenchmarks(): Benchmark[] {
  const rows = getRows<BenchmarkRow>('SELECT * FROM benchmarks ORDER BY name');
  return rows.map((row) => {
    const versions = getRows<VersionRow>(
      'SELECT * FROM benchmark_versions WHERE benchmark_id = ? ORDER BY created_at DESC',
      row.id,
    ).map(mapVersion);
    const current = versions.find((v) => v.id === row.current_version_id) ?? versions[0] ?? null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility as 'public' | 'private',
      dimensions: parseJson<BenchmarkDimension[]>(row.dimensions, []),
      currentVersionId: current?.id ?? null,
      currentVersion: current?.version ?? null,
      itemCount: current?.itemCount ?? 0,
      isDemo: row.is_demo === 1,
      versions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function getBenchmark(id: string): Benchmark | null {
  return listBenchmarks().find((b) => b.id === id) ?? null;
}

export function getVersion(id: string): BenchmarkVersion | null {
  const row = getRow<VersionRow>('SELECT * FROM benchmark_versions WHERE id = ?', id);
  return row ? mapVersion(row) : null;
}

export function listItems(versionId: string): BenchmarkItem[] {
  return getRows<ItemRow>(
    'SELECT * FROM benchmark_items WHERE benchmark_version_id = ? ORDER BY external_key',
    versionId,
  ).map(mapItem);
}

export function getItemRow(id: string): ItemRow | null {
  return getRow<ItemRow>('SELECT * FROM benchmark_items WHERE id = ?', id) ?? null;
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  idempotency_key: string | null;
  model_id: string;
  benchmark_id: string;
  benchmark_version_id: string;
  status: string;
  params: string;
  model_snapshot: string;
  sample_count: number;
  success_count: number;
  fail_count: number;
  timeout_count: number;
  scores: string;
  total_latency_ms: number;
  total_tokens: number;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  error_summary: string | null;
  cancel_requested: number;
  is_demo: number;
  notes: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  model_display_name?: string;
  provider_name?: string;
  benchmark_name?: string;
  benchmark_version?: string;
  report_id?: string | null;
}

const DEFAULT_PARAMS: EvaluationParams = {
  temperature: 0,
  maxTokens: 1024,
  timeoutMs: 60000,
  retries: 2,
  concurrency: 3,
  budgetUsd: 2,
  systemPrompt: null,
};

/** Weighted overall score. See `shared/aggregate.ts` for the implementation. */
export { computeOverall };

export function mapRun(row: RunRow): EvaluationRun {
  const scores = parseJson<Record<string, number>>(row.scores, {});
  return {
    id: row.id,
    modelId: row.model_id,
    modelDisplayName: row.model_display_name ?? '',
    providerName: row.provider_name ?? '',
    benchmarkId: row.benchmark_id,
    benchmarkName: row.benchmark_name ?? '',
    benchmarkVersionId: row.benchmark_version_id,
    benchmarkVersion: row.benchmark_version ?? '',
    status: row.status as EvaluationStatus,
    params: { ...DEFAULT_PARAMS, ...parseJson<Partial<EvaluationParams>>(row.params, {}) },
    modelSnapshot: parseJson<ModelSnapshot>(row.model_snapshot, {
      modelId: '',
      providerId: '',
      providerKind: 'custom',
      providerName: '',
      baseUrl: '',
      modelDbId: row.model_id,
      displayName: '',
      knownVersions: [],
      versionVerification: 'unknown',
    }),
    sampleCount: Number(row.sample_count),
    successCount: Number(row.success_count),
    failCount: Number(row.fail_count),
    timeoutCount: Number(row.timeout_count),
    scores,
    overallScore: computeOverall(scores),
    totalLatencyMs: Number(row.total_latency_ms),
    totalTokens: Number(row.total_tokens),
    estimatedCostUsd: Number(row.estimated_cost_usd),
    actualCostUsd: row.actual_cost_usd === null ? null : Number(row.actual_cost_usd),
    errorSummary: row.error_summary ? parseJson<Record<string, number>>(row.error_summary, {}) : null,
    cancelRequested: row.cancel_requested === 1,
    isDemo: row.is_demo === 1,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    reportId: row.report_id ?? null,
  };
}

const RUN_SELECT = `
SELECT r.*, m.display_name AS model_display_name, p.name AS provider_name,
  b.name AS benchmark_name, bv.version AS benchmark_version,
  (SELECT id FROM reports WHERE run_id = r.id ORDER BY created_at DESC LIMIT 1) AS report_id
FROM evaluation_runs r
JOIN models m ON m.id = r.model_id
JOIN model_providers p ON p.id = m.provider_id
JOIN benchmarks b ON b.id = r.benchmark_id
JOIN benchmark_versions bv ON bv.id = r.benchmark_version_id
`;

export function listRuns(options: { limit?: number; modelId?: string; includeDemo?: boolean } = {}): EvaluationRun[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.modelId) {
    clauses.push('r.model_id = ?');
    params.push(options.modelId);
  }
  if (!options.includeDemo) clauses.push('r.is_demo = 0');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return getRows<RunRow>(`${RUN_SELECT} ${where} ORDER BY r.created_at DESC LIMIT ${limit}`, ...params).map(
    mapRun,
  );
}

export function getRun(id: string): EvaluationRun | null {
  const row = getRow<RunRow>(`${RUN_SELECT} WHERE r.id = ?`, id);
  return row ? mapRun(row) : null;
}

export function getRawRun(id: string): RunRow | null {
  return getRow<RunRow>('SELECT * FROM evaluation_runs WHERE id = ?', id) ?? null;
}

interface ResultRow {
  id: string;
  run_id: string;
  item_id: string;
  dimension: string;
  raw_response: string | null;
  normalized_response: string | null;
  score: number;
  score_breakdown: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  status: string;
  error_message: string | null;
  attempts: number;
  created_at: string;
  external_key?: string;
  question?: string;
  reference?: string | null;
  scorer_type?: string;
}

export function mapResult(row: ResultRow): EvaluationResult {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    externalKey: row.external_key ?? '',
    dimension: row.dimension as BenchmarkDimension,
    question: row.question ?? '',
    reference: row.reference ?? null,
    scorerType: (row.scorer_type ?? 'normalized-match') as ScorerType,
    rawResponse: row.raw_response,
    normalizedResponse: row.normalized_response,
    score: Number(row.score),
    scoreBreakdown: row.score_breakdown
      ? parseJson<Record<string, unknown>>(row.score_breakdown, {})
      : null,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    promptTokens: row.prompt_tokens === null ? null : Number(row.prompt_tokens),
    completionTokens: row.completion_tokens === null ? null : Number(row.completion_tokens),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    status: row.status as EvaluationResult['status'],
    errorMessage: row.error_message,
    attempts: Number(row.attempts ?? 1),
    createdAt: row.created_at,
  };
}

export function listResults(runId: string): EvaluationResult[] {
  return getRows<ResultRow>(
    `SELECT r.*, i.external_key, i.question, i.reference, i.scorer_type
     FROM evaluation_results r
     JOIN benchmark_items i ON i.id = r.item_id
     WHERE r.run_id = ?
     ORDER BY i.external_key`,
    runId,
  ).map(mapResult);
}

// ---------------------------------------------------------------------------
// model detail
// ---------------------------------------------------------------------------

export function getModelDetail(id: string): ModelDetail | null {
  const model = getModelRow(id);
  if (!model) return null;

  const runs = getRows<RunRow>(
    `${RUN_SELECT} WHERE r.model_id = ? AND r.is_demo = 0 AND r.status IN ('completed','partial-failure') ORDER BY r.created_at DESC LIMIT 50`,
    id,
  ).map(mapRun);

  const latestRun = runs[0] ?? null;
  const dimensions: Record<string, number | null> = {};
  if (latestRun) {
    for (const [key, value] of Object.entries(latestRun.scores)) dimensions[key] = value;
  }

  return {
    ...model,
    latestRun,
    scoreSummary: {
      overall: latestRun?.overallScore ?? null,
      dimensions,
      sampleSize: latestRun?.sampleCount ?? 0,
    },
    history: runs
      .slice()
      .reverse()
      .map((run) => ({
        runId: run.id,
        createdAt: run.createdAt,
        overall: run.overallScore,
        status: run.status,
        benchmarkVersion: run.benchmarkVersion,
      })),
  };
}

// ---------------------------------------------------------------------------
// regression events
// ---------------------------------------------------------------------------

interface RegressionRow {
  id: string;
  model_id: string;
  benchmark_version_id: string;
  baseline_run_id: string;
  comparison_run_id: string;
  dimension: string | null;
  baseline_score: number;
  current_score: number;
  delta: number;
  relative_delta: number | null;
  sample_size: number;
  confidence_interval: string | null;
  statistic: string | null;
  p_value: number | null;
  conclusion: string;
  evidence: string | null;
  acknowledged: number;
  created_at: string;
  model_display_name?: string;
}

export function mapRegressionEvent(row: RegressionRow): RegressionEvent {
  return {
    id: row.id,
    modelId: row.model_id,
    modelDisplayName: row.model_display_name ?? '',
    benchmarkVersionId: row.benchmark_version_id,
    baselineRunId: row.baseline_run_id,
    comparisonRunId: row.comparison_run_id,
    dimension: row.dimension ? (row.dimension as BenchmarkDimension) : null,
    baselineScore: Number(row.baseline_score),
    currentScore: Number(row.current_score),
    delta: Number(row.delta),
    relativeDelta: row.relative_delta === null ? null : Number(row.relative_delta),
    sampleSize: Number(row.sample_size),
    confidenceInterval: row.confidence_interval
      ? parseJson<[number, number] | null>(row.confidence_interval, null)
      : null,
    statistic: row.statistic,
    pValue: row.p_value === null ? null : Number(row.p_value),
    conclusion: row.conclusion as RegressionConclusion,
    acknowledged: row.acknowledged === 1,
    createdAt: row.created_at,
  };
}

export function listRegressionEvents(limit = 50): RegressionEvent[] {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  return getRows<RegressionRow>(
    `SELECT e.*, m.display_name AS model_display_name
     FROM regression_events e
     JOIN models m ON m.id = e.model_id
     ORDER BY e.created_at DESC LIMIT ${safeLimit}`,
  ).map(mapRegressionEvent);
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

interface ReportRow {
  id: string;
  public_id: string;
  run_id: string;
  visibility: string;
  title: string;
  summary: string;
  language: string;
  access_token: string;
  created_at: string;
}

export function mapReport(row: ReportRow, includeRun: boolean): Report {
  return {
    id: row.id,
    publicId: row.public_id,
    runId: row.run_id,
    visibility: row.visibility as ReportVisibility,
    title: row.title,
    summary: row.summary,
    language: row.language as Locale,
    createdAt: row.created_at,
    run: includeRun ? getRun(row.run_id) : null,
  };
}

export function listReports(limit = 50): Report[] {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  return getRows<ReportRow>(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ${safeLimit}`).map((row) =>
    mapReport(row, true),
  );
}

export function getReportByPublicId(publicId: string): { report: Report; accessToken: string } | null {
  const row = getRow<ReportRow>('SELECT * FROM reports WHERE public_id = ?', publicId);
  if (!row) return null;
  return { report: mapReport(row, true), accessToken: row.access_token };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

interface SettingsRow {
  id: string;
  language: string;
  default_model_id: string | null;
  default_benchmark_id: string | null;
  default_budget_usd: number;
  report_visibility: string;
  notifications: string;
  updated_at: string;
}

export function getSettings(): UserSettings | null {
  const row = getRow<SettingsRow>('SELECT * FROM user_settings ORDER BY created_at LIMIT 1');
  if (!row) return null;
  return {
    language: row.language as Locale,
    defaultModelId: row.default_model_id,
    defaultBenchmarkId: row.default_benchmark_id,
    defaultBudgetUsd: Number(row.default_budget_usd),
    reportVisibility: row.report_visibility as ReportVisibility,
    notifications: parseJson(row.notifications, { regressionAlerts: true, runCompleted: true }),
    updatedAt: row.updated_at,
  };
}
