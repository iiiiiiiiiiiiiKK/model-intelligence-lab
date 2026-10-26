/**
 * Captures real screenshots of the running app for the README.
 *
 * These are genuine renders of the application, not mockups. Run with the API and
 * web servers up:
 *
 *   npm run dev        # in one terminal
 *   node scripts/screenshots.mjs
 *
 * Full-page captures were 2–3 MB and 16 000 px tall, because the catalog page now
 * lists 132 models. A README needs a readable above-the-fold view, so each shot is
 * clipped to a fixed height (the viewport plus a little, enough to show a table
 * and its header) at deviceScaleFactor 1.5. `scripts/optimize-screenshots.py`
 * re-encodes afterwards.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

const BASE = process.env.SCREENSHOT_BASE_URL || 'http://127.0.0.1:5199';
/** Height of the captured region for desktop shots, in CSS pixels. */
const DESKTOP_HEIGHT = 900;
/** Mobile shots are taller so a full card or two is visible. */
const MOBILE_HEIGHT = 1400;

const SHOTS = [
  { path: '/', name: 'home' },
  { path: '/lab', name: 'lab' },
  { path: '/catalog', name: 'catalog' },
  { path: '/models', name: 'models' },
  { path: '/benchmarks', name: 'benchmarks' },
  { path: '/monitor', name: 'monitor' },
  { path: '/reports', name: 'reports' },
  { path: '/settings', name: 'settings' },
];

const browser = await chromium.launch({ channel: 'msedge' });

const context = await browser.newContext({
  viewport: { width: 1440, height: DESKTOP_HEIGHT },
  deviceScaleFactor: 1.5,
  locale: 'zh-CN',
});
const page = await context.newPage();

async function shoot(name, height = DESKTOP_HEIGHT) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({
    path: file,
    clip: { x: 0, y: 0, width: 1440, height },
  });
  console.log(`captured ${name}.png`);
}

for (const shot of SHOTS) {
  await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shoot(`${shot.name}-zh`);
}

// English variants of the two most representative pages.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /English/ }).first().click();
await page.waitForTimeout(700);
await shoot('home-en');

await page.goto(`${BASE}/catalog`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await shoot('catalog-en');

// Mobile renders.
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1.5,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
});
const mobilePage = await mobile.newPage();

async function shootMobile(name, height = MOBILE_HEIGHT) {
  const file = path.join(outDir, `${name}.png`);
  await mobilePage.screenshot({ path: file, clip: { x: 0, y: 0, width: 390, height } });
  console.log(`captured ${name}.png`);
}

for (const shot of [
  { path: '/', name: 'home-mobile' },
  { path: '/lab', name: 'lab-mobile' },
]) {
  await mobilePage.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
  await mobilePage.waitForTimeout(900);
  await shootMobile(shot.name);
}

await browser.close();
console.log(`\nScreenshots written to ${outDir}`);
