/**
 * Fetches the public model directory and saves the raw payload for code
 * generation.
 *
 * Kept separate from the generator so a build can re-generate the shipped
 * catalog from a cached file with no network access.
 *
 * Usage: node scripts/fetch-catalog.mjs [outputPath]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = 'https://openrouter.ai/api/v1/models';
const out = process.argv[2] ?? path.join(os.tmpdir(), 'or-models.json');

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30000);

try {
  console.log(`fetching ${url} …`);
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'model-intelligence-lab/0.1' },
    signal: controller.signal,
  });
  if (!response.ok) {
    console.error(`upstream returned HTTP ${response.status}`);
    process.exit(1);
  }
  const payload = await response.json();
  const count = Array.isArray(payload?.data) ? payload.data.length : 0;
  if (count === 0) {
    console.error('upstream returned no models; refusing to overwrite the cache');
    process.exit(1);
  }
  fs.writeFileSync(out, JSON.stringify(payload), 'utf8');
  console.log(`saved ${count} models to ${out}`);
} catch (error) {
  console.error(`fetch failed: ${error.message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
