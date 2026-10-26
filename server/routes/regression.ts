import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { compareRuns, checkComparability } from '../stats/regression';
import { listRegressionEvents, listRuns, getRun } from '../db/mappers';
import { ApiError } from '../errors';

export const regressionRouter = Router();

const compareSchema = z.object({
  baselineRunId: z.string().min(1),
  comparisonRunId: z.string().min(1),
});

regressionRouter.post('/regression/compare', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = compareSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid comparison payload', parsed.error.flatten());
    }
    if (parsed.data.baselineRunId === parsed.data.comparisonRunId) {
      throw new ApiError('BAD_REQUEST', 'Baseline and comparison runs must differ');
    }
    const baseline = getRun(parsed.data.baselineRunId);
    const comparison = getRun(parsed.data.comparisonRunId);
    if (!baseline) throw new ApiError('NOT_FOUND', 'Baseline run not found');
    if (!comparison) throw new ApiError('NOT_FOUND', 'Comparison run not found');

    const report = compareRuns({
      baselineRunId: parsed.data.baselineRunId,
      comparisonRunId: parsed.data.comparisonRunId,
    });
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

regressionRouter.get('/regression/comparability', (req: Request, res: Response, next: NextFunction) => {
  try {
    const baselineRunId = String(req.query.baselineRunId ?? '');
    const comparisonRunId = String(req.query.comparisonRunId ?? '');
    if (!baselineRunId || !comparisonRunId) {
      throw new ApiError('BAD_REQUEST', 'baselineRunId and comparisonRunId are required');
    }
    res.json(checkComparability(baselineRunId, comparisonRunId));
  } catch (err) {
    next(err);
  }
});

regressionRouter.get('/regression-events', (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 50);
  const events = listRegressionEvents(Number.isFinite(limit) ? limit : 50);
  res.json({ events, total: events.length });
});

/** Candidate baselines for a model: earlier runs on the same benchmark version. */
regressionRouter.get('/regression/candidates', (req: Request, res: Response, next: NextFunction) => {
  try {
    const modelId = String(req.query.modelId ?? '');
    if (!modelId) throw new ApiError('BAD_REQUEST', 'modelId is required');
    const runs = listRuns({ modelId, limit: 50 }).filter((r) =>
      ['completed', 'partial-failure'].includes(r.status),
    );
    res.json({
      runs: runs.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        benchmarkVersion: r.benchmarkVersion,
        benchmarkVersionId: r.benchmarkVersionId,
        status: r.status,
        overallScore: r.overallScore,
        sampleCount: r.sampleCount,
      })),
    });
  } catch (err) {
    next(err);
  }
});
