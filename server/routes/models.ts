import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { listModels, getModelDetail, getProvider } from '../db/mappers';
import { db, newId, nowIso } from '../db';
import { ApiError } from '../errors';
import { getExternalScoresForModel } from '../catalog/import';

export const modelsRouter = Router();

// NOTE: `/providers` now lives in `routes/providers.ts`, which owns the full
// CRUD + credential surface. The duplicate route was removed so there is one
// definition of what a provider response looks like.

const pricingSchema = z
  .object({
    inputPerMillion: z.number().min(0).nullable(),
    outputPerMillion: z.number().min(0).nullable(),
  })
  .nullable()
  .optional();

const createModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  knownVersions: z.array(z.string().max(100)).max(20).optional(),
  // Optional list pricing in USD per 1M tokens. Without it, cost stays null and
  // the UI reports "unknown" rather than inventing a number.
  pricing: pricingSchema,
  notes: z.string().max(2000).optional(),
});

modelsRouter.get('/models', (req: Request, res: Response) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;

  let models = listModels();
  if (search) {
    models = models.filter(
      (m) =>
        m.displayName.toLowerCase().includes(search) ||
        m.modelId.toLowerCase().includes(search) ||
        m.providerName.toLowerCase().includes(search),
    );
  }
  if (providerId) models = models.filter((m) => m.providerId === providerId);
  if (status) models = models.filter((m) => m.status === status);

  res.json({ models, total: models.length });
});

modelsRouter.post('/models', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createModelSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid model payload', parsed.error.flatten());
    }
    const provider = getProvider(parsed.data.providerId);
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');

    const existing = db
      .prepare('SELECT id FROM models WHERE provider_id = ? AND model_id = ?')
      .get(provider.id, parsed.data.modelId);
    if (existing) throw new ApiError('CONFLICT', 'This provider/model pair is already registered');

    const id = newId();
    const now = nowIso();
    const metadata: Record<string, unknown> = {};
    if (parsed.data.pricing) metadata.pricing = parsed.data.pricing;
    if (parsed.data.notes) metadata.notes = parsed.data.notes;

    db.prepare(
      `INSERT INTO models (id, provider_id, model_id, display_name, known_versions, version_verification, metadata, status, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, 0, ?, ?)`,
    ).run(
      id,
      provider.id,
      parsed.data.modelId,
      parsed.data.displayName,
      JSON.stringify(parsed.data.knownVersions ?? []),
      JSON.stringify(metadata),
      provider.hasCredential ? 'connected' : 'registered',
      now,
      now,
    );

    const model = getModelDetail(id);
    res.status(201).json({ model });
  } catch (err) {
    next(err);
  }
});

modelsRouter.get('/models/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const detail = getModelDetail(req.params.id);
    if (!detail) throw new ApiError('NOT_FOUND', 'Model not found');

    // Third-party reference scores travel in their own field, with their own
    // source and timestamp, so a client can never confuse them with this
    // deployment's own measurements.
    const external = getExternalScoresForModel(detail.modelId);

    res.json({
      model: detail,
      external: {
        matched: external.matched,
        scores: external.scores,
        disclaimer:
          'These scores were published by a third party. They are not produced by this deployment, are not comparable under its rules and cannot be reproduced from this repository.',
      },
    });
  } catch (err) {
    next(err);
  }
});
