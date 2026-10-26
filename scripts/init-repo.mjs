/**
 * Creates the local git repository and the initial commit without requiring a
 * `git` binary (this environment has none). Uses isomorphic-git, which writes a
 * standard `.git` directory that real git can open later.
 *
 * What this does NOT do: push. There are no GitHub credentials in this
 * environment, so publishing is a documented remaining human step.
 *
 * Usage: node scripts/init-repo.mjs [--dry-run] [--message "commit message"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import git from 'isomorphic-git';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const messageIndex = argv.indexOf('--message');
const customMessage = messageIndex >= 0 ? argv[messageIndex + 1] : null;

/** Mirrors .gitignore closely enough to build an honest file list. */
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-server',
  'coverage',
  'artifacts',
  'playwright-report',
  'test-results',
  'data',
  '.tmp',
  '.vite',
  '.git',
]);

function shouldIgnore(relativePath) {
  const segments = relativePath.split('/');
  if (segments.some((segment) => IGNORE_DIRS.has(segment))) return true;
  if (segments.some((segment) => segment.endsWith('.tmpdir'))) return true;
  const base = segments[segments.length - 1];
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  if (base.endsWith('.db') || base.endsWith('.db-wal') || base.endsWith('.db-shm')) return true;
  if (base.endsWith('.log') || base.endsWith('.local') || base.endsWith('.tsbuildinfo')) return true;
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  return false;
}

function walk(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (shouldIgnore(relative)) continue;
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

const files = walk(root).sort();

// Guard: never stage a database or an env file, even if the walker is wrong.
const forbidden = files.filter((file) => /(^|\/)\.env$|\.db$|\.db-wal$|\.db-shm$/.test(file));
if (forbidden.length > 0) {
  console.error('Refusing to continue: forbidden files would be committed:', forbidden);
  process.exit(1);
}

console.log(`Files to commit: ${files.length}`);
for (const file of files.slice(0, 200)) console.log(`  ${file}`);
if (files.length > 200) console.log(`  … and ${files.length - 200} more`);

if (dryRun) {
  console.log('\nDry run: no repository written.');
  process.exit(0);
}

const gitdir = path.join(root, '.git');
if (!fs.existsSync(gitdir)) {
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  console.log('\nInitialised repository at .git (branch main)');
} else {
  console.log('\nRepository already exists, reusing it');
}

for (const file of files) {
  await git.add({ fs, dir: root, filepath: file });
}
console.log(`Staged ${files.length} files`);

const preStatus = await git.statusMatrix({ fs, dir: root, filter: (file) => !shouldIgnore(file) });
const unchanged = preStatus.every(([, head, workdir, stage]) => head === 1 && workdir === 1 && stage === 1) && (await git.log({ fs, dir: root, depth: 1 })).length > 0;
if (unchanged) {
  console.log('没有文件变更，不创建空提交。');
  process.exit(0);
}

const sha = await git.commit({
  fs,
  dir: root,
  message: customMessage ?? `feat: Model Intelligence Lab — reproducible LLM evaluation and regression detection

Backend
- Express API with uniform error envelopes, zod validation, rate limiting
- node:sqlite persistence with immutable benchmark versions and run snapshots
- Evaluation engine: resumable worker, retries, timeouts, budget cap,
  cancellation, idempotency keys
- Scoring registry: exact/normalized/numeric/JSON-schema/rule-based scorers,
  plus explicitly non-executing unit-test, LLM-judge and human interfaces
- Regression statistics: McNemar exact test, Wilson intervals, paired
  difference with CI, Holm correction, comparability gating
- SSRF guard and secret redaction on every outbound provider call

Dataset
- 128 first-party items across six dimensions, deterministic scorers

Frontend
- React + TypeScript + Tailwind, deep forest green design tokens
- 11 pages: overview, models, model detail, compare, lab, monitor,
  benchmarks, reports, report detail, community, settings
- zh-CN / en with catalogue parity enforced by tests; locale persists

Testing
- 167 vitest tests (unit, API, component, engine integration over real HTTP)
- 48 Playwright tests (desktop + mobile), including overflow checks
- Verification scripts: api smoke, full-loop against a stub provider,
  runtime visual/design assertions`,
  author: {
    // The repository owner's GitHub identity. GitHub links a commit to a profile
    // only when the author email is on that account, so the noreply form is used
    // rather than a placeholder that resolves to nobody.
    name: process.env.GIT_AUTHOR_NAME || 'KK-Trade',
    email: process.env.GIT_AUTHOR_EMAIL || '132676579+iiiiiiiiiiiiiKK@users.noreply.github.com',
  },
});

console.log(`Committed: ${sha.slice(0, 12)} on main`);

const log = await git.log({ fs, dir: root, depth: 1 });
for (const entry of log) {
  console.log(`  ${entry.oid.slice(0, 12)} ${entry.commit.message.split('\n')[0]}`);
}

const status = await git.statusMatrix({ fs, dir: root, filter: (file) => !shouldIgnore(file) });
const dirty = status.filter(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1);
console.log(`Working tree: ${dirty.length === 0 ? 'clean' : `${dirty.length} modified path(s)`}`);
