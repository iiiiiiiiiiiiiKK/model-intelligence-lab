import { migrate, dbFilePath } from './index';
import { seedRegistry, seedDemoData, ensureUserSettings } from './seed';

migrate();

const registry = seedRegistry();
console.log(`[db:seed] registry: ${JSON.stringify(registry)}`);

ensureUserSettings();
console.log('[db:seed] default settings ensured');

const withDemo = !process.argv.includes('--no-demo');
if (withDemo) {
  const demo = seedDemoData();
  console.log(`[db:seed] demo data: ${JSON.stringify(demo)}`);
} else {
  console.log('[db:seed] demo data skipped (--no-demo)');
}

console.log(`[db:seed] database at ${dbFilePath}`);
