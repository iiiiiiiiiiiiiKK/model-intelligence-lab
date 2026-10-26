import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db, newId, nowIso, getRow, getRows } from '../db';
import { listBenchmarks, getBenchmark, getVersion, listItems, mapVersion } from '../db/mappers';
import { ApiError } from '../errors';
import { scoreResponse } from '../scoring';
import { CORE_DATASET_META } from '../benchmarks/dataset';
import type { BenchmarkDimension, ScorerType } from '../../shared/types';
import { DIMENSIONS, SCORER_TYPES } from '../../shared/constants';

export const benchmarksRouter = Router();

benchmarksRouter.get('/benchmarks', (req: Request, res: Response) => {
  const dimension = typeof req.query.dimension === 'string' ? req.query.dimension : null;
  let benchmarks = listBenchmarks();
  if (dimension) {
    benchmarks = benchmarks.filter((b) => b.dimensions.includes(dimension as BenchmarkDimension));
  }
  res.json({
    benchmarks,
    dimensions: DIMENSIONS,
    scorerTypes: SCORER_TYPES,
    datasetMeta: {
      source: CORE_DATASET_META.source,
      sourceLicense: CORE_DATASET_META.sourceLicense,
      scorerVersion: CORE_DATASET_META.scorerVersion,
    },
  });
});

benchmarksRouter.get('/benchmarks/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const benchmark = getBenchmark(req.params.id);
    if (!benchmark) throw new ApiError('NOT_FOUND', 'Benchmark not found');
    const versionId = benchmark.currentVersionId;
    const items = versionId ? listItems(versionId) : [];
    res.json({ benchmark, items });
  } catch (err) {
    next(err);
  }
});

benchmarksRouter.get('/benchmarks/:id/versions/:versionId/items', (req: Request, res: Response, next: NextFunction) => {
  try {
    const version = getVersion(req.params.versionId);
    if (!version || version.benchmarkId !== req.params.id) {
      throw new ApiError('NOT_FOUND', 'Benchmark version not found');
    }
    res.json({ version, items: listItems(version.id) });
  } catch (err) {
    next(err);
  }
});

const itemSchema = z.object({
  externalKey: z.string().min(1).max(64),
  dimension: z.enum([
    'reasoning',
    'coding',
    'instruction-following',
    'factuality',
    'stability',
    'behavior',
  ]),
  question: z.string().min(1).max(8000),
  reference: z.string().max(4000).nullable().optional(),
  scorerType: z.enum([
    'exact-match',
    'normalized-match',
    'numeric-tolerance',
    'json-schema',
    'rule-based',
    'unit-test',
    'llm-judge',
    'human',
  ]),
  scorerConfig: z.record(z.unknown()).default({}),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  source: z.string().max(200).default('user-submitted'),
  sourceLicense: z.string().max(100).default('CC-BY-4.0'),
});

const newVersionSchema = z.object({
  // Semver-like, optionally with a pre-release tag (e.g. 1.2, 1.2.3, 2.0.0-test).
  version: z
    .string()
    .max(40)
    .regex(/^\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?$/, 'Version must look like 1.2, 1.2.3 or 2.0.0-rc1'),
  notes: z.string().max(2000).default(''),
  items: z.array(itemSchema).min(1).max(500),
  setAsCurrent: z.boolean().default(true),
});

/**
 * Importing a new benchmark version.
 *
 * Versions are immutable: the endpoint always creates a *new* version row and
 * never mutates an existing one, so historical runs keep their original meaning.
 */
benchmarksRouter.post('/benchmarks/:id/versions', (req: Request, res: Response, next: NextFunction) => {
  try {
    const benchmark = getBenchmark(req.params.id);
    if (!benchmark) throw new ApiError('NOT_FOUND', 'Benchmark not found');
    if (benchmark.isDemo) throw new ApiError('FORBIDDEN', 'Demo benchmarks cannot be extended');

    const parsed = newVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid benchmark version payload', parsed.error.flatten());
    }

    const existing = getRow<{ id: string }>(
      'SELECT id FROM benchmark_versions WHERE benchmark_id = ? AND version = ?',
      benchmark.id,
      parsed.data.version,
    );
    if (existing) {
      throw new ApiError(
        'CONFLICT',
        `Version ${parsed.data.version} already exists. Benchmark versions are immutable — publish a new version number instead.`,
      );
    }

    const keys = new Set<string>();
    for (const item of parsed.data.items) {
      if (keys.has(item.externalKey)) {
        throw new ApiError('VALIDATION_FAILED', `Duplicate item key: ${item.externalKey}`);
      }
      keys.add(item.externalKey);
      if (item.scorerType === 'json-schema') {
        const schema = (item.scorerConfig as { schema?: unknown }).schema;
        if (!schema || typeof schema !== 'object') {
          throw new ApiError(
            'VALIDATION_FAILED',
            `Item ${item.externalKey}: json-schema scorer requires scorerConfig.schema`,
          );
        }
      }
      if (item.scorerType === 'numeric-tolerance' && !item.reference) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Item ${item.externalKey}: numeric-tolerance scorer requires a reference number`,
        );
      }
      if (item.scorerType === 'rule-based') {
        const rules = (item.scorerConfig as { rules?: unknown }).rules;
        if (!Array.isArray(rules) || rules.length === 0) {
          throw new ApiError(
            'VALIDATION_FAILED',
            `Item ${item.externalKey}: rule-based scorer requires a non-empty rules array`,
          );
        }
      }
    }

    const versionId = newId();
    const now = nowIso();
    const hashPayload = parsed.data.items
      .map((i) => `${i.externalKey}|${i.dimension}|${i.question}|${i.reference ?? ''}|${i.scorerType}`)
      .join('\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < hashPayload.length; i++) {
      h = (h ^ hashPayload.charCodeAt(i)) * 0x01000193;
    }
    const contentHash = `fnv1a:${(h >>> 0).toString(16).padStart(8, '0')}`;

    const dimensions = [...new Set(parsed.data.items.map((i) => i.dimension))];

    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO benchmark_versions (id, benchmark_id, version, content_hash, scorer_version, published, item_count, notes, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        versionId,
        benchmark.id,
        parsed.data.version,
        contentHash,
        CORE_DATASET_META.scorerVersion,
        parsed.data.items.length,
        parsed.data.notes,
        now,
      );

      const insert = db.prepare(
        `INSERT INTO benchmark_items
          (id, benchmark_version_id, external_key, dimension, question, reference, scorer_type, scorer_version, scorer_config, difficulty, source, source_license, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?)`,
      );
      for (const item of parsed.data.items) {
        insert.run(
          newId(),
          versionId,
          item.externalKey,
          item.dimension,
          item.question,
          item.reference ?? null,
          item.scorerType,
          CORE_DATASET_META.scorerVersion,
          JSON.stringify(item.scorerConfig),
          item.difficulty,
          item.source,
          item.sourceLicense,
          now,
          now,
        );
      }

      if (parsed.data.setAsCurrent) {
        const mergeDimensions = [...new Set([...benchmark.dimensions, ...dimensions])];
        db.prepare(
          'UPDATE benchmarks SET current_version_id = ?, dimensions = ?, updated_at = ? WHERE id = ?',
        ).run(versionId, JSON.stringify(mergeDimensions), now, benchmark.id);
      }
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    db.exec('COMMIT');

    const version = getVersion(versionId);
    res.status(201).json({ version, itemCount: parsed.data.items.length });
  } catch (err) {
    next(err);
  }
});

const validateSchemaBody = z.object({
  scorerType: z.enum([
    'exact-match',
    'normalized-match',
    'numeric-tolerance',
    'json-schema',
    'rule-based',
    'unit-test',
    'llm-judge',
    'human',
  ]),
  scorerConfig: z.record(z.unknown()).default({}),
  reference: z.string().nullable().optional(),
  question: z.string().min(1).max(8000),
  response: z.string().max(20000),
});

/** Dry-run endpoint so users can validate a scorer before publishing an item. */
benchmarksRouter.post('/benchmarks/validate-item', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = validateSchemaBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid validation payload', parsed.error.flatten());
    }
    const result = scoreResponse({
      question: parsed.data.question,
      reference: parsed.data.reference ?? null,
      response: parsed.data.response,
      scorer: {
        type: parsed.data.scorerType as ScorerType,
        version: CORE_DATASET_META.scorerVersion,
        config: parsed.data.scorerConfig,
      },
    });
    res.json({ result, passThreshold: 0.75 });
  } catch (err) {
    next(err);
  }
});

/** Version history for a benchmark, including item counts per dimension. */
benchmarksRouter.get('/benchmarks/:id/versions', (req: Request, res: Response, next: NextFunction) => {
  try {
    const benchmark = getBenchmark(req.params.id);
    if (!benchmark) throw new ApiError('NOT_FOUND', 'Benchmark not found');
    const rows = getRows<{
      id: string;
      benchmark_id: string;
      version: string;
      content_hash: string;
      scorer_version: string;
      published: number;
      item_count: number;
      notes: string;
      created_at: string;
    }>('SELECT * FROM benchmark_versions WHERE benchmark_id = ? ORDER BY created_at DESC', benchmark.id);
    res.json({ versions: rows.map(mapVersion) });
  } catch (err) {
    next(err);
  }
});
