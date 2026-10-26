/**
 * Production build wrapper.
 *
 * Two things this fixes, both found by inspecting the output:
 *
 * 1. On Windows the esbuild binary writes temp files to %TEMP%; in confined
 *    environments that path can be unwritable, failing the build with
 *    "Access is denied". TMP/TEMP are pointed at a project-local directory.
 *
 * 2. `.env` contains `NODE_ENV=development` (it configures the *server*), and
 *    Vite lets that leak into `process.env.NODE_ENV` at build time. The result
 *    was a "production" bundle shipping `react-dom.development` — dead weight
 *    plus dev-only warnings. The client build now forces production mode so it
 *    cannot depend on the developer's `.env`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(root, '.tmp');
mkdirSync(tmpDir, { recursive: true });

const env = {
  ...process.env,
  // Force a real production bundle regardless of .env.
  NODE_ENV: 'production',
  TMP: tmpDir,
  TEMP: tmpDir,
  TMPDIR: tmpDir,
};

// Resolve the local vite CLI entry so no shell is involved (no arg escaping risk).
const require = createRequire(import.meta.url);
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');

const child = spawn(process.execPath, [viteBin, 'build', '--mode', 'production'], {
  cwd: root,
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));