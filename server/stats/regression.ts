/**
 * Regression detection.
 *
 * Compares two evaluation runs of the *same* model and builds a per-dimension
 * paired analysis. Comparability is checked first and reported explicitly:
 * a version change, a parameter change or a divergent item set downgrades the
 * conclusion to `not-comparable` instead of producing a misleading delta.
 *
 * The output never asserts vendor intent. Each conclusion is paired with the
 * method, sample size, interval and the discordant-pair counts that produced it.
 */
import { db, newId, nowIso, getRow, getRows, parseJson } from '../db';
import { mcnemarTest, pairedDifference, wilsonInterval, holmCorrection, type PairedCounts } from './index';
import { isPass } from '../scoring';
import type {
  BenchmarkDimension,
  RegressionConclusion,
  RegressionDimensionResult,
  RegressionReport,
  EvaluationParams,
  ModelSnapshot,
} from '../../shared/types';

interface ResultRow {
  item_id: string;
  external_key: string;
  dimension: string;
  score: number;
  status: string;
}

function loadResults(runId: string): ResultRow[] {
  return getRows<ResultRow>(
    `SELECT r.item_id, i.external_key, r.dimension, r.score, r.status
     FROM evaluation_results r
     JOIN benchmark_items i ON i.id = r.item_id
     WHERE r.run_id = ? AND r.status IN ('scored','error','timeout')`,
    runId,
  );
}

interface RunMeta {
  id: string;
  model_id: string;
  benchmark_version_id: string;
  benchmark_id: string;
  params: string;
  model_snapshot: string;
  status: string;
  created_at: string;
  is_demo: number;
  sample_count: number;
}

function loadRunMeta(runId: string): RunMeta | null {
  return getRow<RunMeta>('SELECT * FROM evaluation_runs WHERE id = ?', runId) ?? null;
}

export interface ComparabilityResult {
  comparable: boolean;
  issues: string[];
}

export function checkComparability(baselineId: string, comparisonId: string): ComparabilityResult {
  const issues: string[] = [];
  const a = loadRunMeta(baselineId);
  const b = loadRunMeta(comparisonId);

  if (!a || !b) {
    return { comparable: false, issues: ['one-or-both-runs-missing'] };
  }

  if (a.model_id !== b.model_id) {
    issues.push('different-model');
  }

  if (a.benchmark_version_id !== b.benchmark_version_id) {
    issues.push('different-benchmark-version');
  }

  const snapA = parseJson<ModelSnapshot | null>(a.model_snapshot, null);
  const snapB = parseJson<ModelSnapshot | null>(b.model_snapshot, null);
  if (snapA && snapB) {
    if (snapA.modelId !== snapB.modelId) issues.push('different-provider-model-id');
    if (JSON.stringify(snapA.knownVersions) !== JSON.stringify(snapB.knownVersions)) {
      issues.push('different-known-versions');
    }
  }

  const paramsA = parseJson<Partial<EvaluationParams>>(a.params, {});
  const paramsB = parseJson<Partial<EvaluationParams>>(b.params, {});
  for (const key of ['temperature', 'maxTokens', 'systemPrompt'] as const) {
    if (JSON.stringify(paramsA[key] ?? null) !== JSON.stringify(paramsB[key] ?? null)) {
      issues.push(`different-${camelToKebab(key)}`);
    }
  }

  // Scorer drift: the two runs must have been graded by the same scorer versions.
  const scorerA = getRows<{ scorer_version: string }>(
    `SELECT DISTINCT i.scorer_version FROM evaluation_results r
     JOIN benchmark_items i ON i.id = r.item_id WHERE r.run_id = ?`,
    baselineId,
  ).map((r) => r.scorer_version);
  const scorerB = getRows<{ scorer_version: string }>(
    `SELECT DISTINCT i.scorer_version FROM evaluation_results r
     JOIN benchmark_items i ON i.id = r.item_id WHERE r.run_id = ?`,
    comparisonId,
  ).map((r) => r.scorer_version);
  if (JSON.stringify(scorerA.slice().sort()) !== JSON.stringify(scorerB.slice().sort())) {
    issues.push('different-scorer-version');
  }

  if (a.is_demo === 1 || b.is_demo === 1) {
    issues.push('demo-data');
  }

  if (!['completed', 'partial-failure'].includes(a.status) || !['completed', 'partial-failure'].includes(b.status)) {
    issues.push('run-not-finished');
  }

  return { comparable: issues.length === 0, issues };
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

interface ComparisonInput {
  baselineRunId: string;
  comparisonRunId: string;
}

/**
 * Full paired comparison. Dimensions with fewer than 4 paired items are marked
 * `insufficient-data`; all p-values are Holm-corrected across dimensions.
 */
export function compareRuns(input: ComparisonInput): RegressionReport {
  const baseline = loadRunMeta(input.baselineRunId);
  const comparison = loadRunMeta(input.comparisonRunId);
  if (!baseline || !comparison) {
    throw new Error('run-not-found');
  }

  const comparability = checkComparability(input.baselineRunId, input.comparisonRunId);
  const baseResults = loadResults(input.baselineRunId);
  const compResults = loadResults(input.comparisonRunId);

  const baseMap = new Map(baseResults.map((r) => [r.external_key, r]));
  const compMap = new Map(compResults.map((r) => [r.external_key, r]));

  const sharedKeys = [...baseMap.keys()].filter((key) => compMap.has(key));

  const overall = buildDimensionResult(
    null,
    sharedKeys.map((k) => baseMap.get(k)!).filter(Boolean),
    sharedKeys.map((k) => compMap.get(k)!).filter(Boolean),
    comparability.comparable,
  );

  const dimensions = [...new Set(sharedKeys.map((k) => baseMap.get(k)!.dimension))].sort();
  const perDimension = dimensions.map((dimension) => {
    const keys = sharedKeys.filter((k) => baseMap.get(k)!.dimension === dimension);
    return buildDimensionResult(
      dimension as BenchmarkDimension,
      keys.map((k) => baseMap.get(k)!),
      keys.map((k) => compMap.get(k)!),
      comparability.comparable,
    );
  });

  const pValues = perDimension.map((d) => d.pValue).filter((p): p is number => p !== null);
  if (pValues.length > 1) {
    const adjusted = holmCorrection(pValues);
    let cursor = 0;
    for (const entry of perDimension) {
      if (entry.pValue !== null) {
        entry.adjustedPValue = adjusted[cursor];
        cursor += 1;
        entry.conclusion = conclude(entry, comparability.comparable, entry.adjustedPValue);
      }
    }
  }

  const snapshot = parseJson<ModelSnapshot | null>(comparison.model_snapshot, null);

  return {
    modelId: comparison.model_id,
    modelDisplayName: snapshot?.displayName ?? '',
    baselineRunId: input.baselineRunId,
    comparisonRunId: input.comparisonRunId,
    benchmarkVersion: versionLabel(comparison.benchmark_version_id),
    comparable: comparability.comparable,
    comparabilityIssues: comparability.issues,
    overall,
    dimensions: perDimension,
    eventIds: [],
    createdAt: nowIso(),
  };
}

function versionLabel(versionId: string): string {
  const row = getRow<{ version: string }>('SELECT version FROM benchmark_versions WHERE id = ?', versionId);
  return row?.version ?? versionId;
}

function buildDimensionResult(
  dimension: BenchmarkDimension | null,
  base: ResultRow[],
  comp: ResultRow[],
  comparable: boolean,
): RegressionDimensionResult {
  const n = Math.min(base.length, comp.length);
  const counts: PairedCounts = { bothCorrect: 0, baselineOnlyCorrect: 0, comparisonOnlyCorrect: 0, bothIncorrect: 0 };

  for (let i = 0; i < n; i++) {
    const b = isPass(base[i].score) && base[i].status === 'scored';
    const c = isPass(comp[i].score) && comp[i].status === 'scored';
    if (b && c) counts.bothCorrect++;
    else if (b && !c) counts.baselineOnlyCorrect++;
    else if (!b && c) counts.comparisonOnlyCorrect++;
    else counts.bothIncorrect++;
  }

  const baseScores = base.slice(0, n).map((r) => (r.status === 'scored' ? r.score : 0));
  const compScores = comp.slice(0, n).map((r) => (r.status === 'scored' ? r.score : 0));

  // A dimension whose items all failed to execute is an execution failure, not
  // a capability change: report it as such rather than as a delta of 0.
  const baseScored = base.slice(0, n).filter((r) => r.status === 'scored').length;
  const compScored = comp.slice(0, n).filter((r) => r.status === 'scored').length;

  if (n === 0 || baseScored === 0 || compScored === 0) {
    return {
      dimension,
      baselineScore: 0,
      currentScore: 0,
      delta: 0,
      relativeDelta: null,
      sampleSize: n,
      confidenceInterval: null,
      statistic: null,
      statisticValue: null,
      pValue: null,
      adjustedPValue: null,
      method: 'none',
      conclusion: n === 0 ? 'not-comparable' : 'execution-failed',
      counts: n === 0 ? null : counts,
      baselineInterval: null,
      currentInterval: null,
    };
  }

  const baselineScore = average(baseScores);
  const currentScore = average(compScores);
  const delta = Number((currentScore - baselineScore).toFixed(4));
  const relativeDelta = baselineScore > 0 ? Number((delta / baselineScore).toFixed(4)) : null;

  const mcnemar = mcnemarTest(counts);
  const paired = pairedDifference(baseScores, compScores);

  const baseInterval = wilsonInterval(
    base.slice(0, n).filter((r) => r.status === 'scored' && isPass(r.score)).length,
    n,
  );
  const compInterval = wilsonInterval(
    comp.slice(0, n).filter((r) => r.status === 'scored' && isPass(r.score)).length,
    n,
  );

  const result: RegressionDimensionResult = {
    dimension,
    baselineScore,
    currentScore,
    delta,
    relativeDelta,
    sampleSize: n,
    confidenceInterval: paired.interval ? [round(paired.interval.low), round(paired.interval.high)] : null,
    statistic: mcnemar.discordant > 0 ? mcnemar.method : `${paired.method}-score-diff`,
    statisticValue: mcnemar.discordant > 0 ? mcnemar.statistic : paired.tStatistic,
    pValue: mcnemar.discordant > 0 ? round(mcnemar.pValue, 6) : paired.pValue === null ? null : round(paired.pValue, 6),
    adjustedPValue: null,
    method:
      mcnemar.discordant > 0
        ? `McNemar exact test on ${mcnemar.discordant} discordant pairs; paired score difference with ${(paired.interval?.level ?? 0.95) * 100}% CI`
        : `${paired.method} on paired scores; no discordant pairs`,
    conclusion: 'inconclusive',
    counts,
    baselineInterval: [round(baseInterval.low), round(baseInterval.high)],
    currentInterval: [round(compInterval.low), round(compInterval.high)],
  };

  result.conclusion = conclude(result, comparable, result.pValue);
  return result;
}

const ALPHA = 0.05;

function conclude(
  result: RegressionDimensionResult,
  comparable: boolean,
  pValue: number | null,
): RegressionConclusion {
  if (!comparable) return 'not-comparable';
  if (result.sampleSize < 4) return 'insufficient-data';
  if (result.counts && result.counts.bothCorrect + result.counts.bothIncorrect === result.sampleSize) {
    // Every item passed or failed in both runs: no discordance, no evidence.
    return result.delta === 0 ? 'no-significant-change' : 'inconclusive';
  }
  const p = pValue ?? 1;
  if (p >= ALPHA) return 'no-significant-change';
  if (result.delta < 0) return 'significant-regression';
  if (result.delta > 0) return 'significant-improvement';
  return 'inconclusive';
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Called automatically when a run finishes. Finds the most recent earlier run of
 * the same model on the same benchmark version, and persists the analysis as
 * regression events so the monitor page has an auditable history.
 */
export function recordRegression(comparisonRunId: string): void {
  const comparison = loadRunMeta(comparisonRunId);
  if (!comparison) return;
  if (comparison.is_demo === 1) return;

  const baseline = getRow<{ id: string }>(
    `SELECT id FROM evaluation_runs
     WHERE model_id = ? AND benchmark_version_id = ? AND id != ?
       AND is_demo = 0 AND status IN ('completed','partial-failure')
       AND created_at < ?
     ORDER BY created_at DESC LIMIT 1`,
    comparison.model_id,
    comparison.benchmark_version_id,
    comparisonRunId,
    comparison.created_at,
  );
  if (!baseline) return;

  let report: RegressionReport;
  try {
    report = compareRuns({ baselineRunId: baseline.id, comparisonRunId });
  } catch {
    return;
  }

  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO regression_events
      (id, model_id, benchmark_version_id, baseline_run_id, comparison_run_id, dimension,
       baseline_score, current_score, delta, relative_delta, sample_size, confidence_interval,
       statistic, p_value, conclusion, evidence, acknowledged, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(baseline_run_id, comparison_run_id, dimension) DO UPDATE SET
       baseline_score = excluded.baseline_score,
       current_score = excluded.current_score,
       delta = excluded.delta,
       relative_delta = excluded.relative_delta,
       sample_size = excluded.sample_size,
       confidence_interval = excluded.confidence_interval,
       statistic = excluded.statistic,
       p_value = excluded.p_value,
       conclusion = excluded.conclusion,
       evidence = excluded.evidence`,
  );

  const all = [report.overall, ...report.dimensions];
  for (const entry of all) {
    // SQLite treats NULLs as distinct in UNIQUE constraints, so the overall row
    // (no dimension) is stored under the empty string and mapped back to null.
    insert.run(
      newId(),
      comparison.model_id,
      comparison.benchmark_version_id,
      baseline.id,
      comparisonRunId,
      entry.dimension ?? '',
      entry.baselineScore,
      entry.currentScore,
      entry.delta,
      entry.relativeDelta,
      entry.sampleSize,
      entry.confidenceInterval ? JSON.stringify(entry.confidenceInterval) : null,
      entry.statistic,
      entry.pValue,
      entry.conclusion,
      JSON.stringify({
        method: entry.method,
        counts: entry.counts,
        baselineInterval: entry.baselineInterval,
        currentInterval: entry.currentInterval,
        adjustedPValue: entry.adjustedPValue,
        comparabilityIssues: report.comparabilityIssues,
      }),
      now,
    );
  }
}
