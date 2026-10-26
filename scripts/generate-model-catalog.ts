/**
 * Generates `server/benchmarks/model-catalog.ts` from a cached OpenRouter
 * payload.
 *
 * Why generate a checked-in file instead of fetching at boot:
 *   - `npm install && npm run dev` must work offline;
 *   - the shipped model list should be reviewable in git history;
 *   - a boot-time network call would make startup slow and flaky.
 *
 * Every row keeps its source (`openrouter`, the observation date) so nothing in
 * the generated file looks like it was invented locally.
 *
 * Usage:
 *   curl -s https://openrouter.ai/api/v1/models -o %TEMP%\or-models.json
 *   npx tsx scripts/generate-model-catalog.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { selectCatalog } from '../server/catalog/select';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? path.join(os.tmpdir(), 'or-models.json');

if (!fs.existsSync(source)) {
  console.error(
    `No cached payload at ${source}.\nFetch https://openrouter.ai/api/v1/models and save it there first.`,
  );
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(source, 'utf8')) as { data?: unknown[] };
const { selected } = selectCatalog(raw as Parameters<typeof selectCatalog>[0]);

const observedAt = new Date().toISOString().slice(0, 10);

const lines: string[] = [];
lines.push(`/**`);
lines.push(` * Shipped model catalog.`);
lines.push(` *`);
lines.push(` * GENERATED FILE — do not edit by hand. Regenerate with:`);
lines.push(` *   node scripts/fetch-catalog.mjs && npx tsx scripts/generate-model-catalog.ts`);
lines.push(` *`);
lines.push(` * Source: OpenRouter's public model directory (https://openrouter.ai/api/v1/models),`);
lines.push(` * observed ${observedAt}. Prices are the vendor's published USD list price per`);
lines.push(` * 1M tokens as reported by that directory; they are estimates for budgeting,`);
lines.push(` * and the provider's own invoice always wins.`);
lines.push(` *`);
lines.push(` * These are *catalog* entries: listing a model here means "this model exists and`);
lines.push(` * this is its published price", not "this deployment has evaluated it". A model`);
lines.push(` * only gets a score after you run an evaluation with your own API key.`);
lines.push(` *`);
lines.push(` * Ids use the \`vendor/model\` form that OpenAI-compatible relays accept, so a user`);
lines.push(` * who configures one relay can evaluate any of them without re-registering.`);
lines.push(` */`);
lines.push('');
lines.push(`export interface CatalogSeedModel {`);
lines.push(`  /** \`vendor/model\`, the id a relay expects. */`);
lines.push(`  modelId: string;`);
lines.push(`  displayName: string;`);
lines.push(`  vendor: string;`);
lines.push(`  /** Published USD per 1M input tokens, or null when absent. */`);
lines.push(`  inputPerMillion: number | null;`);
lines.push(`  outputPerMillion: number | null;`);
lines.push(`  contextLength: number | null;`);
lines.push(`  inputModalities: string[];`);
lines.push(`}`);
lines.push('');
lines.push(`export const CATALOG_SOURCE = {`);
lines.push(`  id: 'openrouter',`);
lines.push(`  url: 'https://openrouter.ai/api/v1/models',`);
lines.push(`  observedAt: '${observedAt}',`);
lines.push(`} as const;`);
lines.push('');
lines.push(`export const MODEL_CATALOG: CatalogSeedModel[] = [`);

for (const entry of selected) {
  const name = entry.name.replace(/'/g, "\\'");
  const modalities = JSON.stringify(entry.inputModalities);
  lines.push(`  {`);
  lines.push(`    modelId: '${entry.id}',`);
  lines.push(`    displayName: '${name}',`);
  lines.push(`    vendor: '${entry.vendor}',`);
  lines.push(`    inputPerMillion: ${entry.inputPerMillion === null ? 'null' : entry.inputPerMillion},`);
  lines.push(`    outputPerMillion: ${entry.outputPerMillion === null ? 'null' : entry.outputPerMillion},`);
  lines.push(`    contextLength: ${entry.contextLength === null ? 'null' : entry.contextLength},`);
  lines.push(`    inputModalities: ${modalities},`);
  lines.push(`  },`);
}

lines.push(`];`);
lines.push('');

const target = path.join(root, 'server', 'benchmarks', 'model-catalog.ts');
fs.writeFileSync(target, lines.join('\n'), 'utf8');

console.log(`wrote ${target}`);
console.log(`models: ${selected.length}`);
console.log(
  `with pricing: ${selected.filter((entry) => entry.inputPerMillion !== null).length}`,
);
