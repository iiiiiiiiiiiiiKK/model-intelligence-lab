/**
 * Ad-hoc probe: run the catalog selector against the cached OpenRouter payload.
 * Usage: npx tsx scripts/probe-catalog.ts [path-to-json]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { selectCatalog } from '../server/catalog/select';

const file =
  process.argv[2] ?? path.join(os.tmpdir(), 'or-models.json');

if (!fs.existsSync(file)) {
  console.error(`No cached payload at ${file}. Fetch https://openrouter.ai/api/v1/models and save it there.`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const { selected, skipped } = selectCatalog(raw);

console.log(`selected: ${selected.length}`);
console.log(`skipped:  ${JSON.stringify(skipped)}`);

const byVendor: Record<string, number> = {};
for (const entry of selected) byVendor[entry.vendor] = (byVendor[entry.vendor] ?? 0) + 1;
console.log(`vendors:  ${JSON.stringify(byVendor)}`);

console.log(
  `coverage: arena=${selected.filter((e) => e.arenaElo !== null).length}` +
    ` aa=${selected.filter((e) => e.aaIntelligenceIndex !== null).length}` +
    ` pricing=${selected.filter((e) => e.inputPerMillion !== null).length}`,
);

console.log('\nfirst 15:');
for (const entry of selected.slice(0, 15)) {
  console.log(
    `  ${entry.id.padEnd(40)} elo=${String(entry.arenaElo ?? '—').padStart(4)}` +
      ` aa=${String(entry.aaIntelligenceIndex ?? '—').padStart(5)}` +
      ` in=${entry.inputPerMillion === null ? '—' : `$${entry.inputPerMillion}`}`,
  );
}
