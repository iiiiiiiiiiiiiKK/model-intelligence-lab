/**
 * Persistence layer backed by Node's built-in `node:sqlite` (Node >= 22.5).
 * Everything goes through this module so a swap to Postgres later only has to
 * re-implement the small repository helpers below.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from '../config';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// `node:sqlite` is not in Vite's builtin list, so a static `import` would make
// the bundler look for a package named "sqlite". Resolving it through
// `createRequire` keeps it a genuine runtime builtin for both tsx and vitest.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export const dbFilePath = env.MODEL_LAB_DB_PATH
  ? path.resolve(env.MODEL_LAB_DB_PATH)
  : path.join(repoRoot, 'data', 'model-lab.db');

fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

export const db = new DatabaseSync(dbFilePath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  has_credential INTEGER NOT NULL DEFAULT 0,
  api_key_ciphertext TEXT,
  api_key_hint TEXT,
  base_url_override INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  known_versions TEXT NOT NULL DEFAULT '[]',
  version_verification TEXT NOT NULL DEFAULT 'unknown',
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'registered',
  is_demo INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  dimensions TEXT NOT NULL DEFAULT '[]',
  current_version_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_versions (
  id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id),
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  scorer_version TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 1,
  item_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(benchmark_id, version)
);

CREATE TABLE IF NOT EXISTS benchmark_items (
  id TEXT PRIMARY KEY,
  benchmark_version_id TEXT NOT NULL REFERENCES benchmark_versions(id),
  external_key TEXT NOT NULL,
  dimension TEXT NOT NULL,
  question TEXT NOT NULL,
  reference TEXT,
  scorer_type TEXT NOT NULL,
  scorer_version TEXT NOT NULL,
  scorer_config TEXT NOT NULL DEFAULT '{}',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  source TEXT NOT NULL DEFAULT '',
  source_license TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(benchmark_version_id, external_key)
);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  model_id TEXT NOT NULL,
  benchmark_id TEXT NOT NULL,
  benchmark_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  params TEXT NOT NULL DEFAULT '{}',
  model_snapshot TEXT NOT NULL DEFAULT '{}',
  sample_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  timeout_count INTEGER NOT NULL DEFAULT 0,
  scores TEXT NOT NULL DEFAULT '{}',
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL,
  error_summary TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  raw_response TEXT,
  normalized_response TEXT,
  score REAL NOT NULL DEFAULT 0,
  score_breakdown TEXT,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  status TEXT NOT NULL DEFAULT 'scored',
  error_message TEXT,
  provider_response_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, item_id)
);

CREATE TABLE IF NOT EXISTS regression_events (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  benchmark_version_id TEXT NOT NULL,
  baseline_run_id TEXT NOT NULL,
  comparison_run_id TEXT NOT NULL,
  dimension TEXT,
  baseline_score REAL NOT NULL,
  current_score REAL NOT NULL,
  delta REAL NOT NULL,
  relative_delta REAL,
  sample_size INTEGER NOT NULL,
  confidence_interval TEXT,
  statistic TEXT,
  p_value REAL,
  conclusion TEXT NOT NULL,
  evidence TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(baseline_run_id, comparison_run_id, dimension)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'private',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'zh-CN',
  access_token TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  id TEXT PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'zh-CN',
  default_model_id TEXT,
  default_benchmark_id TEXT,
  default_budget_usd REAL NOT NULL DEFAULT 2,
  report_visibility TEXT NOT NULL DEFAULT 'private',
  notifications TEXT NOT NULL DEFAULT '{"regressionAlerts":true,"runCompleted":true}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_submissions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dimension TEXT,
  reference TEXT,
  author TEXT NOT NULL DEFAULT 'anonymous',
  status TEXT NOT NULL DEFAULT 'pending',
  review_note TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

-- Third-party reference scores (Arena Elo, Artificial Analysis index, …).
--
-- Deliberately a SEPARATE table from evaluation_runs/evaluation_results:
--   * these numbers come from someone else's harness, not ours;
--   * they are not reproducible from this repository;
--   * they cannot be filtered by our comparability rules (same items, same
--     params, same scorer versions).
-- Keeping them apart makes it structurally impossible for a third-party score to
-- leak into our overall score, rankings or regression detection.
CREATE TABLE IF NOT EXISTS external_scores (
  id TEXT PRIMARY KEY,
  model_ref TEXT NOT NULL,
  source TEXT NOT NULL,
  metric TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  sample_size INTEGER,
  source_url TEXT,
  observed_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  raw TEXT,
  UNIQUE(model_ref, source, metric, category)
);

CREATE TABLE IF NOT EXISTS external_imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  models_seen INTEGER NOT NULL DEFAULT 0,
  scores_written INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  message TEXT,
  imported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
CREATE INDEX IF NOT EXISTS idx_versions_benchmark ON benchmark_versions(benchmark_id);
CREATE INDEX IF NOT EXISTS idx_items_version ON benchmark_items(benchmark_version_id);
CREATE INDEX IF NOT EXISTS idx_items_dimension ON benchmark_items(dimension);
CREATE INDEX IF NOT EXISTS idx_runs_model ON evaluation_runs(model_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON evaluation_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_version ON evaluation_runs(benchmark_version_id);
CREATE INDEX IF NOT EXISTS idx_runs_idempotency ON evaluation_runs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_results_run ON evaluation_results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_item ON evaluation_results(item_id);
CREATE INDEX IF NOT EXISTS idx_results_dimension ON evaluation_results(dimension);
CREATE INDEX IF NOT EXISTS idx_regressions_model ON regression_events(model_id);
CREATE INDEX IF NOT EXISTS idx_regressions_created ON regression_events(created_at);
CREATE INDEX IF NOT EXISTS idx_reports_public ON reports(public_id);
CREATE INDEX IF NOT EXISTS idx_reports_run ON reports(run_id);
CREATE INDEX IF NOT EXISTS idx_community_status ON community_submissions(status);
`;

let migrated = false;

/**
 * Column additions for databases created by an earlier version.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so each candidate is checked against
 * `PRAGMA table_info`. This keeps an existing database usable after an upgrade
 * instead of failing at boot.
 */
function applyColumnMigrations(): void {
  const additions: Array<{ table: string; column: string; ddl: string }> = [
    { table: 'model_providers', column: 'api_key_ciphertext', ddl: 'TEXT' },
    { table: 'model_providers', column: 'api_key_hint', ddl: 'TEXT' },
    { table: 'model_providers', column: 'base_url_override', ddl: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'model_providers', column: 'is_builtin', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  ];

  for (const entry of additions) {
    const columns = db.prepare(`PRAGMA table_info(${entry.table})`).all() as Array<{ name: string }>;
    if (columns.length === 0) continue; // table does not exist yet
    if (columns.some((column) => column.name === entry.column)) continue;
    db.exec(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.ddl}`);
  }
}

export function migrate(): void {
  if (migrated) return;
  db.exec(SCHEMA);
  applyColumnMigrations();
  markSeededProvidersBuiltin();
  migrated = true;
}

/**
 * Rows created by the seed for the three vendor defaults must be flagged
 * `is_builtin = 1`, otherwise the UI would offer a delete button whose only
 * outcome is a confusing conflict. Databases created before that column existed
 * get corrected here.
 */
function markSeededProvidersBuiltin(): void {
  const columns = db.prepare('PRAGMA table_info(model_providers)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'is_builtin')) return;
  db.prepare(
    "UPDATE model_providers SET is_builtin = 1 WHERE id IN ('prov-openai','prov-deepseek','prov-openai-compatible')",
  ).run();
}

export function getRow<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function getRows<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function exec(sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}
