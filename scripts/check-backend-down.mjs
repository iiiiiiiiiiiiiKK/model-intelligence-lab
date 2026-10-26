/**
 * One-off check: what does the UI show when the API process is stopped?
 *
 * Playwright's own webServer config would start the API for us, so this drives
 * the browser directly against the already-running Vite dev server.
 *
 * Usage: node scripts/check-backend-down.mjs
 */
import { chromium } from '@playwright/test';

const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5199';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8790';

const apiUp = await fetch(`${API}/api/health`)
  .then((response) => response.ok)
  .catch(() => false);

console.log(`API at ${API}: ${apiUp ? 'UP' : 'DOWN (this is what we want to test)'}`);
if (apiUp) {
  console.log('Stop the API first, then re-run. Nothing was tested.');
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();
await page.goto(`${WEB}/models`, { waitUntil: 'domcontentloaded' });

// Give the request cycle time to fail and render.
await page.waitForTimeout(4000);

const body = await page.locator('body').innerText();

console.log('\n--- visible text ---');
console.log(body.split('\n').filter(Boolean).slice(0, 18).join('\n'));

const hasFriendly = /后端服务没有响应|backend is not responding/i.test(body);
const hasRawCode = /HTTP_500/.test(body);
const hasGeneric = /Request failed with status 500/.test(body);
const hasRetry = await page.getByRole('button', { name: /重试|Retry/ }).count();

console.log('\n--- assertions ---');
console.log(`friendly message shown ....... ${hasFriendly ? 'PASS' : 'FAIL'}`);
console.log(`raw "HTTP_500" hidden ........ ${hasRawCode ? 'FAIL' : 'PASS'}`);
console.log(`generic 500 text hidden ...... ${hasGeneric ? 'FAIL' : 'PASS'}`);
console.log(`retry button offered ......... ${hasRetry > 0 ? 'PASS' : 'FAIL'}`);

await browser.close();
const ok = hasFriendly && !hasRawCode && !hasGeneric && hasRetry > 0;
console.log(`\n${ok ? 'backend-down UX verified' : 'backend-down UX NOT fixed'}`);
process.exit(ok ? 0 : 1);
