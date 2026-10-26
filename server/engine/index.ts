/**
 * Evaluation engine.
 *
 * Runs persist in SQLite and are executed by an in-process worker that is
 * resumed on server start, so a run survives a page reload *and* a server
 * restart. The HTTP layer only creates/cancels/reads runs; it never holds the
 * request open while the model is being called.
 */
import { db, newId, nowIso, getRow, getRows, parseJson } from '../db';
import { listItems, getModelRow, getVersion, getProvider } from '../db/mappers';
import { scoreResponse } from '../scoring';
import { getTransport, resolveBaseUrl, estimateCostUsd, AdapterError, type Pricing } from '../providers';
import { env } from '../config';
import { resolveRunCredential, envVarNameFor } from '../credentials';
import { ApiError } from '../errors';
import { computeOverall } from '../db/mappers';
import { recordRegression } from '../stats/regression';
import type {
  BenchmarkDimension,
  EvaluationParams,
  ModelSnapshot,
  ProviderKind,
} from '../../shared/types';

interface RunRowInternal {
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
}

const active = new Set<string>();
const abortControllers = new Map<string, AbortController>();

export interface CreateRunInput {
  modelId: string;
  benchmarkVersionId?: string;
  benchmarkId?: string;
  params?: Partial<EvaluationParams>;
  itemLimit?: number;
  idempotencyKey?: string | null;
  notes?: string;
}

export function isProviderConfigured(providerId: string, kind: ProviderKind): boolean {
  return Boolean(resolveRunCredential(providerId, kind).value);
}

function clampParams(input: Partial<EvaluationParams> | undefined): EvaluationParams {
  const base: EvaluationParams = {
    temperature: 0,
    maxTokens: 1024,
    timeoutMs: env.EVAL_REQUEST_TIMEOUT_MS,
    retries: env.EVAL_MAX_RETRIES,
    concurrency: env.EVAL_MAX_CONCURRENCY,
    budgetUsd: env.EVAL_DEFAULT_BUDGET_USD,
    systemPrompt: null,
  };
  const merged = { ...base, ...(input ?? {}) };
  return {
    temperature: Math.min(Math.max(Number(merged.temperature ?? 0), 0), 2),
    maxTokens: Math.min(Math.max(Math.round(Number(merged.maxTokens ?? 1024)), 16), 16384),
    timeoutMs: Math.min(Math.max(Math.round(Number(merged.timeoutMs ?? 60000)), 1000), 600000),
    retries: Math.min(Math.max(Math.round(Number(merged.retries ?? 2)), 0), 5),
    concurrency: Math.min(Math.max(Math.round(Number(merged.concurrency ?? 3)), 1), 8),
    budgetUsd: Math.max(Number(merged.budgetUsd ?? 2), 0),
    systemPrompt:
      typeof merged.systemPrompt === 'string' && merged.systemPrompt.trim().length > 0
        ? merged.systemPrompt.trim().slice(0, 4000)
        : null,
  };
}

/**
 * Creates a queued run. Rejects when the model's provider has no server-side
 * credential — the UI shows a configuration guide instead of a fake success.
 */
export function createRun(input: CreateRunInput): { id: string; reused: boolean } {
  const model = getModelRow(input.modelId);
  if (!model) throw new ApiError('NOT_FOUND', 'Model not found');

  const provider = getProvider(model.providerId);
  if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');

  const credential = resolveRunCredential(provider.id, provider.kind);
  if (!credential.value) {
    throw new ApiError(
      'PROVIDER_NOT_CONFIGURED',
      `No API key is configured for provider "${provider.name}". Add one in Settings → Providers (or set ${envVarNameFor(provider.kind) ?? 'a provider key'} in .env).`,
    );
  }

  // Resolve benchmark version: explicit > benchmark current > dataset current.
  let versionId = input.benchmarkVersionId ?? null;
  if (!versionId && input.benchmarkId) {
    const bench = getRow<{ current_version_id: string | null }>(
      'SELECT current_version_id FROM benchmarks WHERE id = ?',
      input.benchmarkId,
    );
    versionId = bench?.current_version_id ?? null;
  }
  if (!versionId) {
    const bench = getRow<{ current_version_id: string | null }>(
      "SELECT current_version_id FROM benchmarks WHERE id = 'bench-core'",
    );
    versionId = bench?.current_version_id ?? null;
  }
  if (!versionId) throw new ApiError('BAD_REQUEST', 'No benchmark version available');

  const version = getVersion(versionId);
  if (!version) throw new ApiError('NOT_FOUND', 'Benchmark version not found');
  if (!version.published) throw new ApiError('CONFLICT', 'Benchmark version is not published');

  if (input.idempotencyKey) {
    const existing = getRow<{ id: string; status: string }>(
      'SELECT id, status FROM evaluation_runs WHERE idempotency_key = ?',
      input.idempotencyKey,
    );
    if (existing) return { id: existing.id, reused: true };
  }

  const params = clampParams(input.params);
  const snapshot: ModelSnapshot = {
    modelId: model.modelId,
    providerId: model.providerId,
    providerKind: provider.kind,
    providerName: provider.name,
    baseUrl: resolveBaseUrl(provider.kind, provider.baseUrl),
    modelDbId: model.id,
    displayName: model.displayName,
    knownVersions: model.knownVersions,
    versionVerification: model.versionVerification,
  };

  const totalItems = version.itemCount;
  const sampleCount = input.itemLimit
    ? Math.min(Math.max(Math.round(input.itemLimit), 1), Math.min(totalItems, env.EVAL_MAX_ITEMS_PER_RUN))
    : Math.min(totalItems, env.EVAL_MAX_ITEMS_PER_RUN);

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO evaluation_runs
      (id, idempotency_key, model_id, benchmark_id, benchmark_version_id, status, params, model_snapshot,
       sample_count, success_count, fail_count, timeout_count, scores, total_latency_ms, total_tokens,
       estimated_cost_usd, actual_cost_usd, error_summary, cancel_requested, is_demo, notes, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, 0, 0, '{}', 0, 0, 0, NULL, NULL, 0, 0, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.idempotencyKey ?? null,
    model.id,
    version.benchmarkId,
    versionId,
    JSON.stringify(params),
    JSON.stringify(snapshot),
    sampleCount,
    input.notes ?? '',
    now,
    now,
  );

  // Materialise pending result rows so progress is resumable and visible.
  const items = listItems(versionId).slice(0, sampleCount);
  const insertResult = db.prepare(
    `INSERT OR IGNORE INTO evaluation_results
      (id, run_id, item_id, dimension, raw_response, normalized_response, score, score_breakdown,
       latency_ms, prompt_tokens, completion_tokens, cost_usd, status, error_message, provider_response_id, attempts, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 'pending', NULL, NULL, 0, ?)`,
  );
  for (const item of items) {
    insertResult.run(newId(), id, item.id, item.dimension, now);
  }

  db.prepare('UPDATE evaluation_runs SET sample_count = ? WHERE id = ?').run(items.length, id);

  return { id, reused: false };
}

/** Kicks the worker without awaiting it. */
export function startRun(runId: string): void {
  if (active.has(runId)) return;
  active.add(runId);
  void executeRun(runId)
    .catch((err) => {
      console.error(`[engine] run ${runId} crashed:`, err);
      finalizeRun(runId, 'failed', String((err as Error).message ?? err));
    })
    .finally(() => {
      active.delete(runId);
      abortControllers.delete(runId);
    });
}

export function cancelRun(runId: string): boolean {
  const row = getRow<{ status: string }>('SELECT status FROM evaluation_runs WHERE id = ?', runId);
  if (!row) return false;
  if (['completed', 'failed', 'cancelled', 'partial-failure'].includes(row.status)) return false;
  db.prepare("UPDATE evaluation_runs SET cancel_requested = 1, status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?").run(
    nowIso(),
    nowIso(),
    runId,
  );
  db.prepare(
    "UPDATE evaluation_results SET status = 'cancelled', error_message = 'Run cancelled by user' WHERE run_id = ? AND status = 'pending'",
  ).run(runId);
  abortControllers.get(runId)?.abort();
  return true;
}

/** Resumes runs that were interrupted by a restart. */
export function resumeInterruptedRuns(): number {
  const rows = getRows<{ id: string }>(
    "SELECT id FROM evaluation_runs WHERE status IN ('queued','running') ORDER BY created_at",
  );
  for (const row of rows) {
    db.prepare("UPDATE evaluation_runs SET status = 'queued', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
    startRun(row.id);
  }
  return rows.length;
}

async function executeRun(runId: string): Promise<void> {
  const run = getRow<RunRowInternal>('SELECT * FROM evaluation_runs WHERE id = ?', runId);
  if (!run) return;
  if (run.status === 'cancelled') return;

  const params = clampParams(parseJson<Partial<EvaluationParams>>(run.params, {}));
  const snapshot = parseJson<ModelSnapshot | null>(run.model_snapshot, null);
  if (!snapshot || !snapshot.modelId) {
    finalizeRun(runId, 'failed', 'Model configuration snapshot is missing.');
    return;
  }

  // The credential is resolved at execution time, not creation time, so a key
  // added in the UI takes effect for queued runs without restarting anything.
  const resolved = resolveRunCredential(snapshot.providerId, snapshot.providerKind);
  if (!resolved.value) {
    finalizeRun(
      runId,
      'failed',
      `No API key configured for provider "${snapshot.providerName}". Add one in Settings → Providers and re-run.`,
    );
    return;
  }
  const credential = resolved.value;

  db.prepare("UPDATE evaluation_runs SET status = 'running', updated_at = ? WHERE id = ?").run(nowIso(), runId);

  const pending = getRows<{
    id: string;
    item_id: string;
    dimension: string;
    external_key: string;
    question: string;
    reference: string | null;
    scorer_type: string;
    scorer_version: string;
    scorer_config: string;
  }>(
    `SELECT r.id, r.item_id, r.dimension, i.external_key, i.question, i.reference,
            i.scorer_type, i.scorer_version, i.scorer_config
     FROM evaluation_results r
     JOIN benchmark_items i ON i.id = r.item_id
     WHERE r.run_id = ? AND r.status = 'pending'
     ORDER BY i.external_key`,
    runId,
  );

  const modelRow = getModelRow(run.model_id);
  const metadata = (modelRow?.metadata ?? {}) as { pricing?: Pricing };
  const transport = getTransport(snapshot.providerKind);
  const controller = new AbortController();
  abortControllers.set(runId, controller);

  const budget = params.budgetUsd;
  let spent = Number(run.estimated_cost_usd ?? 0);
  let budgetExceeded = false;

  const queue = [...pending];
  const concurrency = params.concurrency;

  const worker = async () => {
    for (;;) {
      if (controller.signal.aborted || budgetExceeded) return;
      const task = queue.shift();
      if (!task) return;

      const cancelledNow = getRow<{ cancel_requested: number }>(
        'SELECT cancel_requested FROM evaluation_runs WHERE id = ?',
        runId,
      );
      if (!cancelledNow || cancelledNow.cancel_requested === 1) return;

      const scorerConfig = {
        type: task.scorer_type as never,
        version: task.scorer_version,
        config: parseJson<Record<string, unknown>>(task.scorer_config, {}),
      };

      let attempts = 0;
      let lastError: string | null = null;

      for (;;) {
        attempts += 1;
        try {
          const result = await transport.chat({
            baseUrl: snapshot.baseUrl,
            apiKey: credential,
            modelId: snapshot.modelId,
            messages: [
              ...(params.systemPrompt
                ? [{ role: 'system' as const, content: params.systemPrompt }]
                : []),
              { role: 'user' as const, content: task.question },
            ],
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            timeoutMs: params.timeoutMs,
            signal: controller.signal,
          });

          const scored = scoreResponse({
            question: task.question,
            reference: task.reference,
            response: result.text,
            scorer: scorerConfig,
          });

          const cost = estimateCostUsd(metadata.pricing, result.promptTokens, result.completionTokens);

          db.prepare(
            `UPDATE evaluation_results SET raw_response = ?, normalized_response = ?, score = ?,
              score_breakdown = ?, latency_ms = ?, prompt_tokens = ?, completion_tokens = ?,
              cost_usd = ?, status = 'scored', error_message = NULL, provider_response_id = ?,
              attempts = ? WHERE id = ?`,
          ).run(
            truncate(result.text, 20000),
            truncate(scored.normalized, 4000),
            scored.score,
            JSON.stringify(scored.breakdown),
            result.latencyMs,
            result.promptTokens,
            result.completionTokens,
            cost,
            result.providerResponseId,
            attempts,
            task.id,
          );

          spent += cost ?? 0;
          if (budget > 0 && spent > budget) {
            budgetExceeded = true;
            markPendingSkipped(runId, `Budget of $${budget} exceeded; remaining items were not executed.`);
          }
          break;
        } catch (err) {
          lastError = err instanceof AdapterError ? `${err.kind}: ${err.message}` : String((err as Error).message);
          const retryable = err instanceof AdapterError ? err.retryable : false;
          const isAuth = err instanceof AdapterError && err.kind === 'auth';
          if (!retryable || isAuth || attempts > params.retries) {
            const status = err instanceof AdapterError && err.kind === 'timeout' ? 'timeout' : 'error';
            db.prepare(
              `UPDATE evaluation_results SET status = ?, error_message = ?, attempts = ?, latency_ms = ? WHERE id = ?`,
            ).run(status, truncate(lastError, 1000), attempts, null, task.id);
            break;
          }
          await sleep(Math.min(500 * 2 ** (attempts - 1), 8000));
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, worker));
  } catch (err) {
    finalizeRun(runId, 'failed', `Engine failure: ${(err as Error).message}`);
    return;
  }

  // Anything still pending means cancellation or an unexpected stop.
  const stillPending = getRow<{ c: number }>(
    "SELECT COUNT(*) AS c FROM evaluation_results WHERE run_id = ? AND status = 'pending'",
    runId,
  );
  const cancelled = getRow<{ cancel_requested: number }>(
    'SELECT cancel_requested FROM evaluation_runs WHERE id = ?',
    runId,
  );
  if (cancelled?.cancel_requested === 1) return;

  if ((stillPending?.c ?? 0) > 0) {
    db.prepare(
      "UPDATE evaluation_results SET status = 'cancelled', error_message = 'Not executed' WHERE run_id = ? AND status = 'pending'",
    ).run(runId);
  }

  finalizeRun(runId, null, null);
}

function markPendingSkipped(runId: string, reason: string): void {
  db.prepare(
    "UPDATE evaluation_results SET status = 'error', error_message = ? WHERE run_id = ? AND status = 'pending'",
  ).run(reason, runId);
}

/**
 * Aggregates per-item results into dimensions, records errors, updates model
 * status and creates regression events against the previous comparable run.
 */
export function finalizeRun(runId: string, forcedStatus: string | null, error: string | null): void {
  const run = getRow<RunRowInternal>('SELECT * FROM evaluation_runs WHERE id = ?', runId);
  if (!run) return;
  if (run.status === 'cancelled') return;

  const rows = getRows<{
    dimension: string;
    status: string;
    score: number;
    latency_ms: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cost_usd: number | null;
    error_message: string | null;
  }>('SELECT dimension, status, score, latency_ms, prompt_tokens, completion_tokens, cost_usd, error_message FROM evaluation_results WHERE run_id = ?', runId);

  const scored = rows.filter((r) => r.status === 'scored');
  const failed = rows.filter((r) => r.status === 'error');
  const timedOut = rows.filter((r) => r.status === 'timeout');

  const byDimension = new Map<string, { sum: number; count: number }>();
  for (const row of scored) {
    const entry = byDimension.get(row.dimension) ?? { sum: 0, count: 0 };
    entry.sum += Number(row.score);
    entry.count += 1;
    byDimension.set(row.dimension, entry);
  }
  const scores: Record<string, number> = {};
  for (const [dimension, entry] of byDimension) {
    scores[dimension as BenchmarkDimension] = Number((entry.sum / entry.count).toFixed(4));
  }

  const errorSummary: Record<string, number> = {};
  for (const row of [...failed, ...timedOut]) {
    const key = row.status === 'timeout' ? 'timeout' : categorize(row.error_message);
    errorSummary[key] = (errorSummary[key] ?? 0) + 1;
  }

  const totalLatency = rows.reduce((acc, r) => acc + (r.latency_ms ?? 0), 0);
  const totalTokens = rows.reduce((acc, r) => acc + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0), 0);
  const totalCost = rows.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0);

  let status: string;
  if (forcedStatus) status = forcedStatus;
  else if (scored.length === 0) status = 'failed';
  else if (failed.length + timedOut.length > 0) status = 'partial-failure';
  else status = 'completed';

  const now = nowIso();

  db.prepare(
    `UPDATE evaluation_runs SET status = ?, success_count = ?, fail_count = ?, timeout_count = ?,
      scores = ?, total_latency_ms = ?, total_tokens = ?, estimated_cost_usd = ?,
      error_summary = ?, updated_at = ?, completed_at = ?,
      notes = CASE WHEN ? IS NULL THEN notes ELSE ? END
     WHERE id = ?`,
  ).run(
    status,
    scored.length,
    failed.length,
    timedOut.length,
    JSON.stringify(scores),
    totalLatency,
    totalTokens,
    Number(totalCost.toFixed(6)),
    Object.keys(errorSummary).length > 0 ? JSON.stringify(errorSummary) : null,
    now,
    now,
    error,
    error,
    runId,
  );

  db.prepare("UPDATE models SET status = 'evaluated', last_evaluated_at = ?, updated_at = ? WHERE id = ?").run(
    now,
    now,
    run.model_id,
  );

  if (status === 'completed' || status === 'partial-failure') {
    recordRegression(runId);
  }
}

function categorize(message: string | null): string {
  if (!message) return 'unknown';
  const lower = message.toLowerCase();
  if (lower.includes('auth') || lower.includes('401') || lower.includes('403')) return 'auth';
  if (lower.includes('rate limit') || lower.includes('429')) return 'rate-limit';
  if (lower.includes('budget')) return 'budget';
  if (lower.includes('network')) return 'network';
  return 'provider-error';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRunProgress(runId: string) {
  const totals = getRow<{ total: number; scored: number; failed: number; pending: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END) AS scored,
            SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM evaluation_results WHERE run_id = ?`,
    runId,
  );
  const run = getRow<{ status: string; cancel_requested: number; updated_at: string; error_summary: string | null }>(
    'SELECT status, cancel_requested, updated_at, error_summary FROM evaluation_runs WHERE id = ?',
    runId,
  );
  const lastError = getRow<{ error_message: string | null }>(
    'SELECT error_message FROM evaluation_results WHERE run_id = ? AND error_message IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    runId,
  );
  return {
    runId,
    status: (run?.status ?? 'failed') as never,
    total: Number(totals?.total ?? 0),
    completed: Number(totals?.scored ?? 0),
    failed: Number(totals?.failed ?? 0),
    pending: Number(totals?.pending ?? 0),
    cancelRequested: (run?.cancel_requested ?? 0) === 1,
    lastError: lastError?.error_message ?? null,
    updatedAt: run?.updated_at ?? nowIso(),
  };
}

export function computeRunScores(runId: string): Record<string, number> {
  const rows = getRows<{ dimension: string; score: number }>(
    "SELECT dimension, score FROM evaluation_results WHERE run_id = ? AND status = 'scored'",
    runId,
  );
  const byDimension = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const entry = byDimension.get(row.dimension) ?? { sum: 0, count: 0 };
    entry.sum += Number(row.score);
    entry.count += 1;
    byDimension.set(row.dimension, entry);
  }
  const scores: Record<string, number> = {};
  for (const [dimension, entry] of byDimension) {
    scores[dimension] = Number((entry.sum / entry.count).toFixed(4));
  }
  return scores;
}

export { computeOverall };
