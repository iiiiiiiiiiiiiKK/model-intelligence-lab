import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createRun, startRun, cancelRun, getRunProgress } from '../engine';
import { getRun, listResults, listRuns } from '../db/mappers';
import { ApiError } from '../errors';
import { env } from '../config';

export const evaluationsRouter = Router();

const paramsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(16).max(16384).optional(),
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
    retries: z.number().int().min(0).max(5).optional(),
    concurrency: z.number().int().min(1).max(8).optional(),
    budgetUsd: z.number().min(0).max(1000).optional(),
    systemPrompt: z.string().max(4000).nullable().optional(),
  })
  .optional();

const createSchema = z.object({
  modelId: z.string().min(1),
  benchmarkId: z.string().min(1).optional(),
  benchmarkVersionId: z.string().min(1).optional(),
  params: paramsSchema,
  itemLimit: z.number().int().min(1).max(500).optional(),
  idempotencyKey: z.string().min(8).max(200).nullable().optional(),
  notes: z.string().max(1000).optional(),
});

/**
 * Creates a run and immediately queues it. The HTTP response returns as soon as
 * the run exists; execution continues in the background worker, so a page
 * reload or a closed tab never loses the task.
 */
evaluationsRouter.post('/evaluations', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid evaluation payload', parsed.error.flatten());
    }

    const { id, reused } = createRun({
      modelId: parsed.data.modelId,
      benchmarkId: parsed.data.benchmarkId,
      benchmarkVersionId: parsed.data.benchmarkVersionId,
      params: parsed.data.params,
      itemLimit: parsed.data.itemLimit,
      idempotencyKey: parsed.data.idempotencyKey ?? null,
      notes: parsed.data.notes,
    });

    if (!reused) startRun(id);

    const run = getRun(id);
    res.status(reused ? 200 : 202).json({ run, reused });
  } catch (err) {
    next(err);
  }
});

evaluationsRouter.get('/evaluations', (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 50);
  const modelId = typeof req.query.modelId === 'string' ? req.query.modelId : undefined;
  const includeDemo = req.query.includeDemo === 'true';
  const runs = listRuns({ limit: Number.isFinite(limit) ? limit : 50, modelId, includeDemo });
  res.json({ runs, total: runs.length });
});

/**
 * Cost pre-flight so the UI can show a budget estimate before starting.
 * Registered before `/evaluations/:id` so "estimate" is not captured as an id.
 */
evaluationsRouter.get('/evaluations/estimate', (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = Number(req.query.items ?? 0);
    const maxTokens = Number(req.query.maxTokens ?? 1024);
    if (!Number.isFinite(items) || items < 0) throw new ApiError('BAD_REQUEST', 'items must be a positive number');
    // Rough estimate: ~60 prompt tokens per item, completion capped at maxTokens.
    const promptTokens = items * 60;
    const completionTokens = items * maxTokens;
    res.json({
      items,
      maxTokens,
      promptTokens,
      completionTokens,
      maxItemsPerRun: env.EVAL_MAX_ITEMS_PER_RUN,
      defaultBudgetUsd: env.EVAL_DEFAULT_BUDGET_USD,
      note: 'Token counts are estimates. Actual usage is recorded per result when the provider reports it.',
    });
  } catch (err) {
    next(err);
  }
});

evaluationsRouter.get('/evaluations/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = getRun(req.params.id);
    if (!run) throw new ApiError('NOT_FOUND', 'Evaluation run not found');
    res.json({ run, progress: getRunProgress(run.id) });
  } catch (err) {
    next(err);
  }
});

/** Lightweight polling endpoint used by the lab page while a run executes. */
evaluationsRouter.get('/evaluations/:id/progress', (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = getRun(req.params.id);
    if (!run) throw new ApiError('NOT_FOUND', 'Evaluation run not found');
    res.json({ progress: getRunProgress(run.id), status: run.status });
  } catch (err) {
    next(err);
  }
});

evaluationsRouter.get('/evaluations/:id/results', (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = getRun(req.params.id);
    if (!run) throw new ApiError('NOT_FOUND', 'Evaluation run not found');
    const dimension = typeof req.query.dimension === 'string' ? req.query.dimension : null;
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 500), 1), 2000);

    let results = listResults(run.id);
    if (dimension) results = results.filter((r) => r.dimension === dimension);
    if (status) results = results.filter((r) => r.status === status);
    results = results.slice(0, limit);

    res.json({ run, results, total: results.length });
  } catch (err) {
    next(err);
  }
});

evaluationsRouter.post('/evaluations/:id/cancel', (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = getRun(req.params.id);
    if (!run) throw new ApiError('NOT_FOUND', 'Evaluation run not found');
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new ApiError('CONFLICT', `Run is already ${run.status} and cannot be cancelled`);
    }
    const cancelled = cancelRun(run.id);
    res.json({ cancelled, run: getRun(run.id) });
  } catch (err) {
    next(err);
  }
});
