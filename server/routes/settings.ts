import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db, nowIso, getRow } from '../db';
import { getSettings, listProviders } from '../db/mappers';
import { envVarNameFor } from '../credentials';
import { ApiError } from '../errors';

export const settingsRouter = Router();

settingsRouter.get('/settings', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = getSettings();
    if (!settings) throw new ApiError('NOT_FOUND', 'Settings not initialised. Run `npm run db:seed`.');
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  language: z.enum(['zh-CN', 'en']).optional(),
  defaultModelId: z.string().nullable().optional(),
  defaultBenchmarkId: z.string().nullable().optional(),
  defaultBudgetUsd: z.number().min(0).max(1000).optional(),
  reportVisibility: z.enum(['public', 'private']).optional(),
  notifications: z
    .object({
      regressionAlerts: z.boolean(),
      runCompleted: z.boolean(),
    })
    .optional(),
});

settingsRouter.patch('/settings', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid settings payload', parsed.error.flatten());
    }
    const row = getRow<{ id: string }>('SELECT id FROM user_settings ORDER BY created_at LIMIT 1');
    if (!row) throw new ApiError('NOT_FOUND', 'Settings not initialised');

    const updates: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      updates.push(`${column} = ?`);
      values.push(value);
    };

    if (parsed.data.language !== undefined) push('language', parsed.data.language);
    if (parsed.data.defaultModelId !== undefined) push('default_model_id', parsed.data.defaultModelId);
    if (parsed.data.defaultBenchmarkId !== undefined) {
      push('default_benchmark_id', parsed.data.defaultBenchmarkId);
    }
    if (parsed.data.defaultBudgetUsd !== undefined) push('default_budget_usd', parsed.data.defaultBudgetUsd);
    if (parsed.data.reportVisibility !== undefined) push('report_visibility', parsed.data.reportVisibility);
    if (parsed.data.notifications !== undefined) {
      push('notifications', JSON.stringify(parsed.data.notifications));
    }

    if (updates.length > 0) {
      push('updated_at', nowIso());
      values.push(row.id);
      db.prepare(`UPDATE user_settings SET ${updates.join(', ')} WHERE id = ?`).run(...(values as never[]));
    }

    res.json({ settings: getSettings() });
  } catch (err) {
    next(err);
  }
});

/**
 * Provider status for the settings page.
 *
 * Delegates to the shared provider mapper so this endpoint and
 * `/api/providers` can never disagree. Credential *values* are never included —
 * only a masked hint and the source (`database` or `environment`).
 */
settingsRouter.get('/settings/provider-status', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const providers = listProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      enabled: provider.enabled,
      hasCredential: provider.hasCredential,
      credentialSource: provider.credentialSource,
      credentialHint: provider.credentialHint,
      credentialSourceName: envVarNameFor(provider.kind),
      baseUrl: provider.baseUrl,
      isBuiltin: provider.isBuiltin,
      modelCount: provider.modelCount,
    }));

    res.json({
      providers,
      note:
        'API keys can be added or replaced here at any time; no restart is needed. Environment variables remain a fallback for headless deployments.',
    });
  } catch (err) {
    next(err);
  }
});
