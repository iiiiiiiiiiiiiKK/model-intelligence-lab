// Production container check.
//
// Docker is not available in every environment, so this script validates the
// container contract that *can* be checked without it: the exact file set the
// Dockerfile copies exists, the start command resolves, and `.dockerignore` does
// not exclude anything the build needs.
//
//   node scripts/verify-container-contract.mjs
//
// Exits non-zero on any problem, so CI can gate on it.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  - ${detail}` : ''}`);
};

console.log('Container contract\n');

// 1. Everything the Dockerfile COPYs must exist in the build context.
const copied = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
  'tailwind.config.js',
  'postcss.config.js',
  'index.html',
  'server',
  'shared',
  'src',
  'scripts',
  'public',
];

console.log('Files the Dockerfile copies:');
for (const entry of copied) {
  check(entry, existsSync(path.join(root, entry)));
}

// 2. .dockerignore must not exclude a copied path.
console.log('\n.dockerignore does not block the build:');
const ignoreFile = path.join(root, '.dockerignore');
const ignored = existsSync(ignoreFile)
  ? readFileSync(ignoreFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  : [];

for (const entry of copied) {
  const topLevel = entry.split('/')[0];
  const blocked = ignored.includes(topLevel) || ignored.includes(entry);
  check(`${entry} not ignored`, !blocked);
}
check('.env is ignored (secrets never enter the image)', ignored.includes('.env'));
check('data is ignored (database never enters the image)', ignored.includes('data'));

// 3. The runtime command must resolve to a real module.
console.log('\nRuntime command resolves:');
let tsxResolved = false;
try {
  require.resolve('tsx');
  tsxResolved = true;
} catch {
  tsxResolved = false;
}
check('tsx is installed', tsxResolved);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
check('tsx is a runtime dependency, not a dev one', Boolean(pkg.dependencies?.tsx));
check(
  'start script matches the container CMD',
  pkg.scripts?.start === 'tsx server/index.ts',
  pkg.scripts?.start,
);

const nodeMajor = Number(/(\d+)/.exec(pkg.engines?.node ?? '')?.[1] ?? 0);
check('engines.node is >= 22', nodeMajor >= 22, pkg.engines?.node);

// 4. The image must not be able to boot without access control on 0.0.0.0.
console.log('\nExposure guard is wired:');
const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
check('Dockerfile sets HOST=0.0.0.0', /HOST=0\.0\.0\.0/.test(dockerfile));

const appSource = readFileSync(path.join(root, 'server', 'app.ts'), 'utf8');
check('bootstrap calls assertSafeExposure()', /assertSafeExposure\(\)/.test(appSource));

const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
check(
  'compose requires MODEL_LAB_ACCESS_TOKEN',
  /MODEL_LAB_ACCESS_TOKEN: \$\{MODEL_LAB_ACCESS_TOKEN:\?/.test(compose),
);

const fly = readFileSync(path.join(root, 'fly.toml'), 'utf8');
check('fly.toml keeps the worker alive (auto_stop_machines = false)', /auto_stop_machines = false/.test(fly));
check('fly.toml mounts a volume at /app/data', /destination = '\/app\/data'/.test(fly));

const render = readFileSync(path.join(root, 'render.yaml'), 'utf8');
check('render.yaml declares numInstances: 1', /numInstances: 1/.test(render));
check('render.yaml declares a persistent disk', /mountPath: \/app\/data/.test(render));

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
