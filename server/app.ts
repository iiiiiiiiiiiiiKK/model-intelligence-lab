import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env, envBaseUrlFor } from './config';
import { anyProviderConfigured } from './credentials';
import { migrate, dbFilePath, getRow } from './db';
import { seedRegistry, ensureUserSettings } from './db/seed';
import {
  refreshProviderCredentialFlags,
  syncProviderBaseUrlsFromEnv,
  listProviders,
  listModels,
  listRuns,
  listRegressionEvents,
  listBenchmarks,
} from './db/mappers';
import { ApiError } from './errors';
import { resumeInterruptedRuns } from './engine';
import { modelsRouter } from './routes/models';
import { benchmarksRouter } from './routes/benchmarks';
import { evaluationsRouter } from './routes/evaluations';
import { regressionRouter } from './routes/regression';
import { reportsRouter } from './routes/reports';
import { settingsRouter } from './routes/settings';
import { communityRouter } from './routes/community';
import { compareRouter } from './routes/compare';
import { providersRouter } from './routes/providers';
import { catalogRouter } from './routes/catalog';
import { authRouter } from './routes/auth';
import { assertSafeExposure, authRequired, requireSession } from './auth';
import { APP_VERSION } from '../shared/constants';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: env.MAX_JSON_BODY_BYTES }));
app.use(express.urlencoded({ extended: false, limit: env.MAX_JSON_BODY_BYTES }));

// Security headers. No CSP: the app is served same-origin and Vite's dev client
// needs inline scripts, so a permissive-but-real header set is used instead of a
// policy that would silently break the app.
app.use((_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  next();
});

const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.', retryable: true } },
});
app.use('/api', apiLimiter);

// Write operations get a tighter budget than reads.
const writeLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: Math.max(10, Math.floor(env.RATE_LIMIT_MAX_REQUESTS / 4)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many write requests.', retryable: true } },
});
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return writeLimiter(req, res, next);
});

// ---------------------------------------------------------------------------
// access control
// ---------------------------------------------------------------------------
//
// Mounted before every data route. When MODEL_LAB_ACCESS_TOKEN is unset the gate
// is a no-op, so the default single-machine setup keeps working unchanged.
app.use('/api', requireSession);

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

/** Resolves the credential lookup key for a provider row (registryKey > kind). */
function providerKey(providerId: string, fallbackKind: string): string {
  const row = getRow<{ config: string }>('SELECT config FROM model_providers WHERE id = ?', providerId);
  try {
    return (JSON.parse(row?.config ?? '{}') as { registryKey?: string }).registryKey ?? fallbackKind;
  } catch {
    return fallbackKind;
  }
}

app.get('/api/health', (_req: Request, res: Response) => {
  let database: 'ok' | 'down' = 'ok';
  let demoDataPresent = false;
  try {
    getRow('SELECT 1 AS ok');
    const demo = getRow<{ c: number }>('SELECT COUNT(*) AS c FROM evaluation_runs WHERE is_demo = 1');
    demoDataPresent = (demo?.c ?? 0) > 0;
  } catch {
    database = 'down';
  }

  const providers: Record<string, 'ok' | 'unconfigured'> = {};
  for (const provider of listProviders()) {
    providers[provider.name] = provider.hasCredential ? 'ok' : 'unconfigured';
  }

  const configured = anyProviderConfigured();
  const status = database === 'down' ? 'down' : configured ? 'ok' : 'degraded';

  res.status(database === 'down' ? 503 : 200).json({
    status,
    services: { database, providers },
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    demoDataPresent,
    // The client shows a lock indicator when the instance is gated.
    authRequired: authRequired(),
    databasePath: env.NODE_ENV === 'production' ? undefined : dbFilePath,
  });
});

// ---------------------------------------------------------------------------
// overview (home page)
// ---------------------------------------------------------------------------

app.get('/api/overview', (_req: Request, res: Response) => {
  const models = listModels();
  const benchmarks = listBenchmarks();
  const runs = listRuns({ limit: 12 });
  const events = listRegressionEvents(6);

  const realRunCount = getRow<{ c: number }>(
    "SELECT COUNT(*) AS c FROM evaluation_runs WHERE is_demo = 0 AND status IN ('completed','partial-failure')",
  );
  const demoRunCount = getRow<{ c: number }>('SELECT COUNT(*) AS c FROM evaluation_runs WHERE is_demo = 1');

  const trackedModels = models.filter((m) => m.runCount >= 2).length;
  const evaluatedModels = models.filter((m) => m.runCount >= 1).length;

  const trend = models
    .filter((m) => m.runCount > 0)
    .map((m) => {
      const modelRuns = listRuns({ modelId: m.id, limit: 20 })
        .filter((r) => r.overallScore !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        modelId: m.id,
        displayName: m.displayName,
        points: modelRuns.map((r) => ({ at: r.createdAt, score: r.overallScore as number })),
      };
    })
    .filter((entry) => entry.points.length > 0);

  const dimensionTotals: Record<string, { sum: number; count: number }> = {};
  for (const run of runs) {
    for (const [dimension, score] of Object.entries(run.scores)) {
      const entry = dimensionTotals[dimension] ?? { sum: 0, count: 0 };
      entry.sum += score;
      entry.count += 1;
      dimensionTotals[dimension] = entry;
    }
  }
  const dimensionAverages = Object.fromEntries(
    Object.entries(dimensionTotals).map(([k, v]) => [k, Number((v.sum / v.count).toFixed(4))]),
  );

  res.json({
    counts: {
      models: models.length,
      evaluatedModels,
      trackedModels,
      benchmarks: benchmarks.length,
      benchmarkItems: benchmarks.reduce((acc, b) => acc + b.itemCount, 0),
      realRuns: Number(realRunCount?.c ?? 0),
      demoRuns: Number(demoRunCount?.c ?? 0),
    },
    recentRuns: runs,
    recentEvents: events,
    trend,
    dimensionAverages,
    providerReadiness: listProviders().map((p) => ({
      name: p.name,
      kind: p.kind,
      hasCredential: p.hasCredential,
    })),
  });
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

app.use('/api', authRouter);
app.use('/api', modelsRouter);
app.use('/api', benchmarksRouter);
app.use('/api', evaluationsRouter);
app.use('/api', regressionRouter);
app.use('/api', reportsRouter);
app.use('/api', settingsRouter);
app.use('/api', communityRouter);
app.use('/api', compareRouter);
app.use('/api', providersRouter);
app.use('/api', catalogRouter);

app.use('/api', (_req, _res, next) => {
  next(new ApiError('NOT_FOUND', 'API route not found'));
});

// ---------------------------------------------------------------------------
// static client (production build)
// ---------------------------------------------------------------------------

const distDir = path.join(repoRoot, 'dist');
if (fs.existsSync(distDir)) {
  app.use(
    express.static(distDir, {
      index: false,
      maxAge: env.NODE_ENV === 'production' ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('cache-control', 'no-store');
      },
    }),
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Malformed JSON body.', retryable: false },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api] unhandled error:', message);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', retryable: false },
  });
});

/**
 * Prepares a fresh process: schema, reference data, credential flags and
 * resumption of any run that was interrupted by a restart.
 * Kept separate from `index.ts` so tests can mount `app` without listening.
 */
export function bootstrap(): { resumedRuns: number; syncedProviders: number } {
  // Fail fast rather than serve credentials and a spending path to the internet.
  assertSafeExposure();
  migrate();
  seedRegistry();
  ensureUserSettings();
  // An explicit `*_BASE_URL` in .env is an operator instruction, so rows without
  // a UI-configured override are pinned to it at boot. Runs snapshot the row, so
  // this is what makes a freshly seeded database honour a configured relay.
  const syncedProviders = syncProviderBaseUrlsFromEnv((kind, current) => envBaseUrlFor(kind) ?? current);
  // Flags are recomputed from real credential resolution (database first, then
  // environment), so the UI never claims a key exists when it does not.
  refreshProviderCredentialFlags();
  return { resumedRuns: resumeInterruptedRuns(), syncedProviders };
}

export { providerKey };
