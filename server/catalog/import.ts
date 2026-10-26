/**
 * External catalog import.
 *
 * Pulls a public, credential-free model catalog (OpenRouter's `/api/v1/models`)
 * and writes two things into a local SQLite cache:
 *
 *   1. the curated model list itself (name, vendor, context window, price), and
 *   2. third-party reference scores bundled with that catalog
 *      (Arena Elo from blind pairwise voting, Artificial Analysis indices).
 *
 * Why cache instead of calling upstream per request:
 *   - the app must work offline and must not depend on a third party being up;
 *   - an import is a dated event, so every score row carries `imported_at` and
 *     the UI can say exactly how stale a number is;
 *   - it makes the numbers reviewable in git history rather than appearing
 *     silently.
 *
 * The reference scores live in `external_scores`, a table nothing else reads.
 * They are NEVER merged into `evaluation_runs`, the overall score, rankings or
 * regression detection — see `server/db/index.ts` for the rationale.
 */
import { db, getRow, getRows, newId, nowIso } from '../db';
import { selectCatalog, type CatalogEntry } from './select';
import { matchCatalogEntry } from './match';
import { redactSecrets } from '../security/ssrf';

export const SOURCE_ID = 'openrouter';
export const SOURCE_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 25000;

export interface ImportResult {
  ok: boolean;
  source: string;
  sourceUrl: string;
  modelsSeen: number;
  modelsNew: number;
  scoresWritten: number;
  skipped: { variants: number; nonChat: number; mirror: number };
  importedAt: string;
  coverage: { arena: number; artificialAnalysis: number; pricing: number };
  message: string;
}

interface CacheRow {
  model_ref: string;
  name: string;
  vendor: string;
  context_length: number | null;
  input_per_million: number | null;
  output_per_million: number | null;
  input_modalities: string;
  description: string;
  created_at_source: string | null;
  imported_at: string;
}

/** Ensures the cache table exists even on databases created before this feature. */
export function ensureCatalogSchema(): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS external_catalog (
  model_ref TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  context_length INTEGER,
  input_per_million REAL,
  output_per_million REAL,
  input_modalities TEXT NOT NULL DEFAULT '["text"]',
  description TEXT NOT NULL DEFAULT '',
  created_at_source TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_vendor ON external_catalog(vendor);
CREATE INDEX IF NOT EXISTS idx_external_scores_model ON external_scores(model_ref);
CREATE INDEX IF NOT EXISTS idx_external_scores_source ON external_scores(source);
`);
}

/** Fetches the upstream payload. Throws with a readable message on failure. */
async function fetchCatalog(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(SOURCE_URL, {
      headers: { accept: 'application/json', 'user-agent': 'model-intelligence-lab/0.1' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`upstream returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'AbortError') {
      throw new Error(`upstream request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw new Error(redactSecrets(`upstream request failed: ${(error as Error).message}`));
  } finally {
    clearTimeout(timer);
  }
}

/** Writes the reference scores for one model. Idempotent on (model, source, metric, category). */
function writeScores(modelRef: string, entry: CatalogEntry, observedAt: string): number {
  const upsert = db.prepare(
    `INSERT INTO external_scores
       (id, model_ref, source, metric, category, value, unit, sample_size, source_url, observed_at, imported_at, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(model_ref, source, metric, category) DO UPDATE SET
       value = excluded.value,
       unit = excluded.unit,
       source_url = excluded.source_url,
       observed_at = excluded.observed_at,
       imported_at = excluded.imported_at,
       raw = excluded.raw`,
  );

  let written = 0;

  for (const arena of entry.arenaCategories) {
    upsert.run(
      newId(),
      modelRef,
      SOURCE_ID,
      'arena-elo',
      arena.category,
      arena.elo,
      'elo',
      SOURCE_URL,
      observedAt,
      observedAt,
      JSON.stringify({ arena: 'design_arena', rank: arena.rank }),
    );
    written += 1;
  }

  // The general text arena, when the catalog exposes it separately.
  if (entry.arenaElo !== null && !entry.arenaCategories.some((c) => c.category === 'overall')) {
    upsert.run(
      newId(),
      modelRef,
      SOURCE_ID,
      'arena-elo',
      'overall',
      entry.arenaElo,
      'elo',
      SOURCE_URL,
      observedAt,
      observedAt,
      null,
    );
    written += 1;
  }

  if (entry.aaIntelligenceIndex !== null) {
    upsert.run(
      newId(),
      modelRef,
      SOURCE_ID,
      'intelligence-index',
      'overall',
      entry.aaIntelligenceIndex,
      'index',
      SOURCE_URL,
      observedAt,
      observedAt,
      null,
    );
    written += 1;
  }
  if (entry.aaCodingIndex !== null) {
    upsert.run(
      newId(),
      modelRef,
      SOURCE_ID,
      'coding-index',
      'overall',
      entry.aaCodingIndex,
      'index',
      SOURCE_URL,
      observedAt,
      observedAt,
      null,
    );
    written += 1;
  }
  if (entry.aaAgenticIndex !== null) {
    upsert.run(
      newId(),
      modelRef,
      SOURCE_ID,
      'agentic-index',
      'overall',
      entry.aaAgenticIndex,
      'index',
      SOURCE_URL,
      observedAt,
      observedAt,
      null,
    );
    written += 1;
  }

  return written;
}

/** Performs a real import. Never fabricates: on failure it records the failure. */
export async function importCatalog(): Promise<ImportResult> {
  ensureCatalogSchema();
  const importedAt = nowIso();

  let payload: unknown;
  try {
    payload = await fetchCatalog();
  } catch (error) {
    const message = (error as Error).message;
    db.prepare(
      `INSERT INTO external_imports (id, source, source_url, models_seen, scores_written, status, message, imported_at)
       VALUES (?, ?, ?, 0, 0, 'failed', ?, ?)`,
    ).run(newId(), SOURCE_ID, SOURCE_URL, message, importedAt);

    return {
      ok: false,
      source: SOURCE_ID,
      sourceUrl: SOURCE_URL,
      modelsSeen: 0,
      modelsNew: 0,
      scoresWritten: 0,
      skipped: { variants: 0, nonChat: 0, mirror: 0 },
      importedAt,
      coverage: { arena: 0, artificialAnalysis: 0, pricing: 0 },
      message,
    };
  }

  const { selected, skipped } = selectCatalog(payload as { data?: never[] });

  const upsertModel = db.prepare(
    `INSERT INTO external_catalog
       (model_ref, name, vendor, context_length, input_per_million, output_per_million,
        input_modalities, description, created_at_source, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model_ref) DO UPDATE SET
       name = excluded.name,
       vendor = excluded.vendor,
       context_length = excluded.context_length,
       input_per_million = excluded.input_per_million,
       output_per_million = excluded.output_per_million,
       input_modalities = excluded.input_modalities,
       description = excluded.description,
       created_at_source = excluded.created_at_source,
       imported_at = excluded.imported_at`,
  );

  let scoresWritten = 0;
  let modelsNew = 0;

  db.exec('BEGIN');
  try {
    for (const entry of selected) {
      const existed = getRow<{ model_ref: string }>(
        'SELECT model_ref FROM external_catalog WHERE model_ref = ?',
        entry.id,
      );
      upsertModel.run(
        entry.id,
        entry.name,
        entry.vendor,
        entry.contextLength,
        entry.inputPerMillion,
        entry.outputPerMillion,
        JSON.stringify(entry.inputModalities),
        entry.description,
        entry.createdAt,
        importedAt,
      );
      if (!existed) modelsNew += 1;
      scoresWritten += writeScores(entry.id, entry, importedAt);
    }

    db.prepare(
      `INSERT INTO external_imports (id, source, source_url, models_seen, scores_written, status, message, imported_at)
       VALUES (?, ?, ?, ?, ?, 'ok', ?, ?)`,
    ).run(
      newId(),
      SOURCE_ID,
      SOURCE_URL,
      selected.length,
      scoresWritten,
      `curated ${selected.length} of the catalog; skipped ${skipped.variants} variants, ${skipped.nonChat} non-chat, ${skipped.mirror} mirrors`,
      importedAt,
    );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    const message = redactSecrets((error as Error).message);
    db.prepare(
      `INSERT INTO external_imports (id, source, source_url, models_seen, scores_written, status, message, imported_at)
       VALUES (?, ?, ?, 0, 0, 'failed', ?, ?)`,
    ).run(newId(), SOURCE_ID, SOURCE_URL, message, importedAt);
    return {
      ok: false,
      source: SOURCE_ID,
      sourceUrl: SOURCE_URL,
      modelsSeen: selected.length,
      modelsNew: 0,
      scoresWritten: 0,
      skipped,
      importedAt,
      coverage: { arena: 0, artificialAnalysis: 0, pricing: 0 },
      message,
    };
  }

  return {
    ok: true,
    source: SOURCE_ID,
    sourceUrl: SOURCE_URL,
    modelsSeen: selected.length,
    modelsNew,
    scoresWritten,
    skipped,
    importedAt,
    coverage: {
      arena: selected.filter((entry) => entry.arenaElo !== null).length,
      artificialAnalysis: selected.filter((entry) => entry.aaIntelligenceIndex !== null).length,
      pricing: selected.filter((entry) => entry.inputPerMillion !== null).length,
    },
    message: `imported ${selected.length} models and ${scoresWritten} reference scores`,
  };
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export interface CatalogModel extends CatalogEntry {
  importedAt: string;
  /** Scores from third parties, grouped by metric. Empty when none exist. */
  references: Array<{
    metric: string;
    category: string;
    value: number;
    unit: string;
    source: string;
    observedAt: string;
  }>;
  /** True when a model with the same model_id is registered in this deployment. */
  registeredModelId: string | null;
}

const METRIC_ORDER = ['arena-elo', 'intelligence-index', 'coding-index', 'agentic-index'];

export function listCatalog(options: { vendor?: string; search?: string; limit?: number } = {}): {
  models: CatalogModel[];
  vendors: Array<{ vendor: string; count: number }>;
  lastImport: {
    importedAt: string;
    status: string;
    modelsSeen: number;
    message: string | null;
  } | null;
} {
  ensureCatalogSchema();

  const where: string[] = [];
  const params: unknown[] = [];
  if (options.vendor) {
    where.push('c.vendor = ?');
    params.push(options.vendor);
  }
  if (options.search) {
    where.push('(lower(c.name) LIKE ? OR lower(c.model_ref) LIKE ?)');
    const needle = `%${options.search.toLowerCase()}%`;
    params.push(needle, needle);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);

  const rows = getRows<CacheRow>(
    `SELECT * FROM external_catalog c ${clause} ORDER BY c.vendor, c.input_per_million LIMIT ${limit}`,
    ...params,
  );

  const registered = new Map(
    getRows<{ model_id: string; id: string }>('SELECT model_id, id FROM models').map((row) => [
      row.model_id,
      row.id,
    ]),
  );

  const scoreRows = getRows<{
    model_ref: string;
    metric: string;
    category: string;
    value: number;
    unit: string;
    source: string;
    observed_at: string;
  }>(
    `SELECT model_ref, metric, category, value, unit, source, observed_at
     FROM external_scores
     ORDER BY model_ref, metric, category`,
  );

  const scoresByModel = new Map<string, CatalogModel['references']>();
  for (const row of scoreRows) {
    const list = scoresByModel.get(row.model_ref) ?? [];
    list.push({
      metric: row.metric,
      category: row.category,
      value: Number(row.value),
      unit: row.unit,
      source: row.source,
      observedAt: row.observed_at,
    });
    scoresByModel.set(row.model_ref, list);
  }

  const models: CatalogModel[] = rows.map((row) => {
    const refs = (scoresByModel.get(row.model_ref) ?? []).sort(
      (a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric),
    );
    const arenaOverall =
      refs.find((ref) => ref.metric === 'arena-elo' && ref.category === 'overall')?.value ?? null;
    const aaOverall =
      refs.find((ref) => ref.metric === 'intelligence-index' && ref.category === 'overall')?.value ??
      null;
    const aaCoding =
      refs.find((ref) => ref.metric === 'coding-index' && ref.category === 'overall')?.value ?? null;
    const aaAgentic =
      refs.find((ref) => ref.metric === 'agentic-index' && ref.category === 'overall')?.value ?? null;

    // `registerCatalogModel` stores the full `vendor/model` slug as the model id,
    // but a model may also have been registered under the bare slug. Check both so
    // the "registered" state can never disagree with the models table.
    const bareSlug = row.model_ref.includes('/')
      ? row.model_ref.split('/').slice(1).join('/')
      : row.model_ref;
    const registeredId = registered.get(row.model_ref) ?? registered.get(bareSlug) ?? null;

    return {
      id: row.model_ref,
      name: row.name,
      vendor: row.vendor,
      contextLength: row.context_length === null ? null : Number(row.context_length),
      inputPerMillion: row.input_per_million === null ? null : Number(row.input_per_million),
      outputPerMillion: row.output_per_million === null ? null : Number(row.output_per_million),
      createdAt: row.created_at_source,
      arenaElo: arenaOverall,
      arenaCategories: refs
        .filter((ref) => ref.metric === 'arena-elo' && ref.category !== 'overall')
        .map((ref) => ({ category: ref.category, elo: ref.value, rank: null })),
      aaIntelligenceIndex: aaOverall,
      aaCodingIndex: aaCoding,
      aaAgenticIndex: aaAgentic,
      inputModalities: (() => {
        try {
          const parsed = JSON.parse(row.input_modalities) as unknown;
          return Array.isArray(parsed) ? (parsed as string[]) : ['text'];
        } catch {
          return ['text'];
        }
      })(),
      description: row.description,
      huggingFaceId: null,
      importedAt: row.imported_at,
      references: refs,
      registeredModelId: registeredId,
    };
  });

  const vendors = getRows<{ vendor: string; count: number }>(
    'SELECT vendor, COUNT(*) AS count FROM external_catalog GROUP BY vendor ORDER BY count DESC',
  ).map((row) => ({ vendor: row.vendor, count: Number(row.count) }));

  const lastImport = getRow<{
    imported_at: string;
    status: string;
    models_seen: number;
    message: string | null;
  }>('SELECT imported_at, status, models_seen, message FROM external_imports ORDER BY imported_at DESC LIMIT 1');

  return {
    models,
    vendors,
    lastImport: lastImport
      ? {
          importedAt: lastImport.imported_at,
          status: lastImport.status,
          modelsSeen: Number(lastImport.models_seen),
          message: lastImport.message,
        }
      : null,
  };
}

/**
 * External reference scores for one locally registered model id.
 *
 * Returns an empty list when no confident match exists — better to show nothing
 * than someone else's number for the wrong model.
 */
export function getExternalScoresForModel(localModelId: string): {
  matched: { modelRef: string; name: string; vendor: string } | null;
  scores: Array<{
    metric: string;
    category: string;
    value: number;
    unit: string;
    source: string;
    observedAt: string;
  }>;
} {
  ensureCatalogSchema();
  const index = getRows<{ model_ref: string; vendor: string; name: string }>(
    'SELECT model_ref, vendor, name FROM external_catalog',
  ).map((row) => ({ modelRef: row.model_ref, vendor: row.vendor, name: row.name }));

  const hit = matchCatalogEntry(localModelId, index);
  if (!hit) return { matched: null, scores: [] };

  const scores = getRows<{
    metric: string;
    category: string;
    value: number;
    unit: string;
    source: string;
    observed_at: string;
  }>(
    `SELECT metric, category, value, unit, source, observed_at
     FROM external_scores WHERE model_ref = ? ORDER BY metric, category`,
    hit.modelRef,
  ).map((row) => ({
    metric: row.metric,
    category: row.category,
    value: Number(row.value),
    unit: row.unit,
    source: row.source,
    observedAt: row.observed_at,
  }));

  return { matched: hit, scores };
}

/** Registers a catalog model as a callable model on a provider id. */
export function registerCatalogModel(
  catalogId: string,
  providerId: string,
): { created: boolean; modelId: string | null } {
  ensureCatalogSchema();
  const entry = getRow<CacheRow>('SELECT * FROM external_catalog WHERE model_ref = ?', catalogId);
  if (!entry) return { created: false, modelId: null };

  const provider = getRow<{ id: string; has_credential: number }>(
    'SELECT id, has_credential FROM model_providers WHERE id = ?',
    providerId,
  );
  if (!provider) return { created: false, modelId: null };

  // OpenRouter ids are `vendor/model`; gateways usually want the full slug.
  const modelId = entry.model_ref;
  const existing = getRow<{ id: string }>(
    'SELECT id FROM models WHERE provider_id = ? AND model_id = ?',
    providerId,
    modelId,
  );
  if (existing) return { created: false, modelId: existing.id };

  const id = newId();
  const now = nowIso();
  const pricing =
    entry.input_per_million !== null || entry.output_per_million !== null
      ? {
          pricing: {
            inputPerMillion: entry.input_per_million,
            outputPerMillion: entry.output_per_million,
          },
        }
      : {};

  db.prepare(
    `INSERT INTO models (id, provider_id, model_id, display_name, known_versions, version_verification, metadata, status, is_demo, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', 'unknown', ?, ?, 0, ?, ?)`,
  ).run(
    id,
    providerId,
    modelId,
    entry.name,
    JSON.stringify({ ...pricing, catalogRef: entry.model_ref, contextLength: entry.context_length }),
    provider.has_credential === 1 ? 'connected' : 'registered',
    now,
    now,
  );

  return { created: true, modelId: id };
}
