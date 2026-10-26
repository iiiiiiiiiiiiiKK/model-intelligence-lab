/**
 * End-to-end check of the access-token gate, driven through the real UI.
 *
 * Requires the API to be running WITH MODEL_LAB_ACCESS_TOKEN set and the Vite dev
 * server up, so that the browser hits the gate exactly as a user would.
 *
 * Usage: node scripts/check-auth-ui.mjs <token>
 */
import { chromium } from '@playwright/test';

const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5199';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8790';
const token = process.argv[2];

if (!token) {
  console.error('Usage: node scripts/check-auth-ui.mjs <access-token>');
  process.exit(2);
}

const status = await fetch(`${API}/api/auth/status`)
  .then((response) => response.json())
  .catch(() => null);

if (!status) {
  console.error(`API at ${API} is not reachable. Start it first.`);
  process.exit(2);
}
if (!status.required) {
  console.error('The API is not gated. Restart it with MODEL_LAB_ACCESS_TOKEN set.');
  process.exit(2);
}

const results = [];
const check = (label, pass) => {
  results.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
};

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();

// 1. The app must show the login screen, not the dashboard.
await page.goto(WEB, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const lockedText = await page.locator('body').innerText();
check('login screen is shown', /需要访问令牌|Access token required/i.test(lockedText));
check('no dashboard content leaks before login', !/评测实验室|Evaluation Lab/.test(lockedText));

// 2. A wrong token must be rejected with a clear message.
await page.locator('#access-token').fill('definitely-wrong');
await page.getByRole('button', { name: /进入|Enter/ }).click();
await page.waitForTimeout(2200);
const afterWrong = await page.locator('body').innerText();
check('wrong token is rejected', /令牌不正确|not correct/i.test(afterWrong));

// 3. The right token must let us in.
await page.locator('#access-token').fill(token);
await page.getByRole('button', { name: /进入|Enter/ }).click();
await page.waitForTimeout(4000);
const inside = await page.locator('body').innerText();
check('correct token opens the app', /评测实验室|Evaluation Lab|模型库/i.test(inside));

// 4. A page reload must stay signed in (the session cookie survives).
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const reloaded = await page.locator('body').innerText();
check('session survives a reload', !/需要访问令牌|Access token required/i.test(reloaded));

// 5. Sign-out must close the gate again.
const signOut = page.getByRole('button', { name: /退出登录|Sign out/ });
if (await signOut.count()) {
  await signOut.first().click();
  await page.waitForTimeout(3000);
  const out = await page.locator('body').innerText();
  check('sign out returns to the login screen', /需要访问令牌|Access token required/i.test(out));
} else {
  check('sign out control is present', false);
}

// 6. A forged cookie must not work.
const context2 = await browser.newContext();
const forged = await context2.newPage();
await context2.addCookies([
  { name: 'model_lab_session', value: `${Date.now() + 600000}.forgedsignature`, url: WEB },
]);
await forged.goto(WEB, { waitUntil: 'domcontentloaded' });
await forged.waitForTimeout(2500);
const forgedText = await forged.locator('body').innerText();
check('a forged cookie is rejected', /需要访问令牌|Access token required/i.test(forgedText));

await browser.close();

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
