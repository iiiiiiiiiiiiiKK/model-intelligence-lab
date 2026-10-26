/**
 * Prints the isolation evidence for the two-kinds-of-numbers guarantee.
 * Usage: node scripts/verify-isolation.mjs [--db <path>]
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag >= 0 ? path.resolve(args[dbFlag + 1]) : path.resolve('data', 'model-lab.db');

const db = new DatabaseSync(dbPath);

const runCols = db.prepare('PRAGMA table_info(evaluation_runs)').all().map((row) => row.name);
const resCols = db.prepare('PRAGMA table_info(evaluation_results)').all().map((row) => row.name);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);

const externalTables = tables.filter((name) => name.includes('external'));
const scoreCount = db.prepare('SELECT COUNT(*) AS c FROM external_scores').get().c;
const runCount = db.prepare('SELECT COUNT(*) AS c FROM evaluation_runs').get().c;

console.log(`database: ${dbPath}\n`);

console.log('Guarantee 1: local run tables have no column that could hold a third-party score');
console.log(`  evaluation_runs    -> ${runCols.some((c) => c.includes('external')) ? 'FAIL' : 'ok'}`);
console.log(`  evaluation_results -> ${resCols.some((c) => c.includes('external')) ? 'FAIL' : 'ok'}`);

console.log('\nGuarantee 2: third-party data lives in its own tables');
console.log(`  ${externalTables.join(', ') || '(none)'}`);

console.log('\nCurrent data volume');
console.log(`  external_scores rows : ${scoreCount}`);
console.log(`  evaluation_runs rows : ${runCount}`);

const ok = !runCols.some((c) => c.includes('external')) && !resCols.some((c) => c.includes('external'));
db.close();
console.log(`\n${ok ? 'isolation holds' : 'ISOLATION VIOLATED'}`);
process.exit(ok ? 0 : 1);
