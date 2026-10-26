/**
 * Removes catalog-registered models from the development database.
 *
 * Catalog entries are registered as `vendor/model` ids for browsing/experiment.
 * They are not part of the shipped registry, so a clean development checkout
 * should not carry them. Real runs, reports and the seeded models are untouched.
 *
 * Usage: node scripts/clean-catalog-models.mjs [--dry-run]
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const dryRun = process.argv.includes('--dry-run');
const db = new DatabaseSync(path.resolve('data', 'model-lab.db'));
db.exec('PRAGMA foreign_keys = ON;');

const rows = db.prepare("SELECT id, model_id FROM models WHERE model_id LIKE '%/%'").all();

if (rows.length === 0) {
  console.log('没有目录登记的模型，无需清理。');
  db.close();
  process.exit(0);
}

console.log(`发现 ${rows.length} 个目录登记的模型：`);
for (const row of rows) console.log(`  ${row.model_id}`);

if (dryRun) {
  console.log('\n试运行，未做任何修改。');
  db.close();
  process.exit(0);
}

db.exec('BEGIN');
try {
  for (const row of rows) {
    const runs = db.prepare('SELECT id FROM evaluation_runs WHERE model_id = ?').all(row.id).map((r) => r.id);
    for (const runId of runs) {
      db.prepare('DELETE FROM evaluation_results WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM reports WHERE run_id = ?').run(runId);
      db.prepare(
        'DELETE FROM regression_events WHERE baseline_run_id = ? OR comparison_run_id = ?',
      ).run(runId, runId);
      db.prepare('DELETE FROM evaluation_runs WHERE id = ?').run(runId);
    }
    db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('清理失败，已回滚:', error.message);
  db.close();
  process.exit(1);
}

const remaining = db.prepare('SELECT model_id FROM models ORDER BY model_id').all();
console.log(`\n已删除 ${rows.length} 个目录登记模型。`);
console.log(`剩余模型: ${remaining.map((r) => r.model_id).join(', ')}`);
db.close();
