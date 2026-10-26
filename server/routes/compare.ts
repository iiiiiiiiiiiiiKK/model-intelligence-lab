import { Router, type Request, type Response, type NextFunction } from 'express';
import { compareRuns } from '../stats/regression';
import { getRun, listResults } from '../db/mappers';
import { ApiError } from '../errors';
import type { CompareEntry, CompareResponse } from '../../shared/types';

export const compareRouter = Router();

/**
 * Multi-run comparison. Comparability is evaluated *pairwise against the first
 * run*, and every entry carries its own `comparabilityIssues`, so a user can see
 * exactly why a column is not directly comparable instead of reading a false
 * ranking.
 */
compareRouter.get('/compare', (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = String(req.query.runIds ?? '');
    const runIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);

    if (runIds.length < 2) {
      throw new ApiError('BAD_REQUEST', 'Provide at least two runIds (comma separated)');
    }

    const runs = runIds.map((id) => {
      const run = getRun(id);
      if (!run) throw new ApiError('NOT_FOUND', `Run not found: ${id}`);
      return run;
    });

    const reference = runs[0];
    const alignmentNotes: string[] = [];
    if (new Set(runs.map((r) => r.benchmarkVersionId)).size > 1) {
      alignmentNotes.push('Runs use different benchmark versions; item sets may not overlap.');
    }
    if (new Set(runs.map((r) => r.params.temperature)).size > 1) {
      alignmentNotes.push('Runs use different decoding temperatures.');
    }
    if (new Set(runs.map((r) => r.params.systemPrompt ?? '')).size > 1) {
      alignmentNotes.push('Runs use different system prompts.');
    }
    if (runs.some((r) => r.isDemo)) {
      alignmentNotes.push('At least one run is demo data and is not comparable with real runs.');
    }

    const entries: CompareEntry[] = runs.map((run, index) => {
      const issues: string[] = [];
      if (run.isDemo) issues.push('demo-data');
      if (index > 0) {
        if (run.benchmarkVersionId !== reference.benchmarkVersionId) issues.push('different-benchmark-version');
        if (run.params.temperature !== reference.params.temperature) issues.push('different-temperature');
        if ((run.params.systemPrompt ?? '') !== (reference.params.systemPrompt ?? '')) {
          issues.push('different-system-prompt');
        }
      }
      const executed = run.successCount + run.failCount + run.timeoutCount;
      return {
        runId: run.id,
        modelId: run.modelId,
        modelDisplayName: run.modelDisplayName,
        providerName: run.providerName,
        benchmarkVersion: run.benchmarkVersion,
        status: run.status,
        overallScore: run.overallScore,
        dimensions: run.scores,
        successRate: executed > 0 ? Number((run.successCount / executed).toFixed(4)) : 0,
        errorRate: executed > 0 ? Number(((run.failCount + run.timeoutCount) / executed).toFixed(4)) : 0,
        avgLatencyMs: run.successCount > 0 ? Math.round(run.totalLatencyMs / executed) : 0,
        totalCostUsd: Number(run.estimatedCostUsd.toFixed(6)),
        sampleCount: run.sampleCount,
        comparable: issues.length === 0,
        comparabilityIssues: issues,
      };
    });

    // Per-item matrix, aligned on the shared item set.
    const resultsByRun = new Map(runs.map((run) => [run.id, listResults(run.id)]));
    const itemMeta = new Map<
      string,
      { dimension: CompareResponse['items'][number]['dimension']; question: string }
    >();
    for (const run of runs) {
      for (const result of resultsByRun.get(run.id) ?? []) {
        if (!itemMeta.has(result.externalKey)) {
          itemMeta.set(result.externalKey, { dimension: result.dimension, question: result.question });
        }
      }
    }

    const items: CompareResponse['items'] = [];
    for (const [externalKey, meta] of itemMeta) {
      const row: Record<string, { score: number; status: 'scored' | 'error' | 'timeout' | 'cancelled' }> = {};
      for (const run of runs) {
        const match = (resultsByRun.get(run.id) ?? []).find((r) => r.externalKey === externalKey);
        if (match) row[run.id] = { score: match.score, status: match.status };
      }
      items.push({ itemId: externalKey, dimension: meta.dimension, question: meta.question, results: row });
    }
    items.sort((a, b) => a.itemId.localeCompare(b.itemId));

    const response: CompareResponse = { entries, items: items.slice(0, 500), alignmentNotes };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * Pairwise statistical comparison between exactly two runs, reusing the same
 * regression engine as the monitor page so the numbers always agree.
 */
compareRouter.get('/compare/pairwise', (req: Request, res: Response, next: NextFunction) => {
  try {
    const baselineRunId = String(req.query.baselineRunId ?? '');
    const comparisonRunId = String(req.query.comparisonRunId ?? '');
    if (!baselineRunId || !comparisonRunId) {
      throw new ApiError('BAD_REQUEST', 'baselineRunId and comparisonRunId are required');
    }
    res.json({ report: compareRuns({ baselineRunId, comparisonRunId }) });
  } catch (err) {
    next(err);
  }
});
