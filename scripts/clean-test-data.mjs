/**
 * Removes artefacts created by the automated test suites and by
 * `scripts/configure-relay.mjs` from a development database.
 *
 * Targets, in order:
 *   - providers whose name matches the Playwright/screenshot patterns
 *     (`UI relay …`, `manual probe`) and their models,
 *   - models named `stub-model` and every run/report/event that used them,
 *   - anything else already handled by the older stub-only cleaner.
 *
 * Real runs, real providers, reports about real models and the seeded benchmark
 * are never touched. Every deletion is scoped by an explicit predicate and the
 * whole thing runs in one transaction.
 *
 * Usage: node scripts/clean-test-data.mjs [--dry-run] [--db <path>]
 */
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbFlagIndex = args.indexOf('--db');
const dbPath =
  dbFlagIndex >= 0 ? path.resolve(args[dbFlagIndex + 1]) : path.resolve('data', 'model-lab.db');

/** Provider names created by the e2e suites and manual probing. */
const TEST_PROVIDER_PATTERN = /^(UI relay |manual probe$|Playwright |Try before save$|Disposable$|Keyless$|Bad scheme$)/;
const TEST_MODEL_IDS = ['stub-model'];

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

const providers = db.prepare('SELECT id, name FROM model_providers').all();
const testProviders = providers.filter((row) => TEST_PROVIDER_PATTERN.test(row.name));

const modelIdSet = new Set(TEST_MODEL_IDS);
const models = db.prepare('SELECT id, model_id, provider_id, display_name FROM models').all();
const testModels = models.filter(
  (row) => modelIdSet.has(row.model_id) || testProviders.some((provider) => provider.id === row.provider_id),
);

const modelRows = testModels.map((row) => row.id);
const placeholders = modelRows.map(() => '?').join(',');
const runs =
  modelRows.length > 0
    ? db.prepare(`SELECT id FROM evaluation_runs WHERE model_id IN (${placeholders})`).all(...modelRows)
    : [];

console.log(`数据库: ${dbPath}`);
console.log(`测试服务商: ${testProviders.length}`);
testProviders.forEach((row) => console.log(`  - ${row.name}`));
console.log(`测试模型: ${testModels.length}`);
console.log(`关联评测任务: ${runs.length}`);

if (testProviders.length === 0 && testModels.length === 0 && runs.length === 0) {
  console.log('\n没有需要清理的测试数据。');
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log('\n试运行，未做任何修改。');
  db.close();
  process.exit(0);
}

let deletedResults = 0;
let deletedReports = 0;
let deletedEvents = 0;

db.exec('BEGIN');
try {
  for (const run of runs) {
    deletedResults += db.prepare('DELETE FROM evaluation_results WHERE run_id = ?').run(run.id).changes;
    deletedReports += db.prepare('DELETE FROM reports WHERE run_id = ?').run(run.id).changes;
    deletedEvents += db
      .prepare('DELETE FROM regression_events WHERE baseline_run_id = ? OR comparison_run_id = ?')
      .run(run.id, run.id).changes;
    db.prepare('DELETE FROM evaluation_runs WHERE id = ?').run(run.id);
  }

  if (modelRows.length > 0) {
    db.prepare(`DELETE FROM models WHERE id IN (${placeholders})`).run(...modelRows);
  }
  for (const provider of testProviders) {
    db.prepare('DELETE FROM model_providers WHERE id = ?').run(provider.id);
  }

  // The stub run may have overwritten the vendor default base URL.
  db.prepare(
    "UPDATE model_providers SET base_url = 'https://api.openai.com/v1' WHERE id = 'prov-openai-compatible' AND base_url_override = 0",
  ).run();

  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('清理失败，已回滚:', error.message);
  db.close();
  process.exit(1);
}

console.log(
  `\n已删除: ${runs.length} 个任务, ${deletedResults} 条结果, ${deletedReports} 份报告, ` +
    `${deletedEvents} 个事件, ${testModels.length} 个模型, ${testProviders.length} 个服务商`,
);

const remainingRuns = db.prepare('SELECT COUNT(*) AS c FROM evaluation_runs').get();
const remainingProviders = db.prepare('SELECT name FROM model_providers ORDER BY name').all();
const remainingModels = db.prepare('SELECT model_id FROM models ORDER BY model_id').all();
console.log(`剩余评测任务: ${remainingRuns.c}`);
console.log(`剩余服务商: ${remainingProviders.map((row) => row.name).join(', ')}`);
console.log(`剩余模型: ${remainingModels.map((row) => row.model_id).join(', ') || '（无）'}`);
db.close();
