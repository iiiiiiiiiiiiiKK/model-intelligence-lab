/**
 * Visual sanity check without eyeballing screenshots.
 *
 * Asserts the design system actually applies at runtime: background tokens,
 * accent colour usage, font stack, contrast ratios, and that no page renders as
 * an empty shell. This complements the screenshots rather than replacing them.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.SCREENSHOT_BASE_URL || 'http://127.0.0.1:5199';
const PAGES = ['/', '/models', '/lab', '/benchmarks', '/monitor', '/reports', '/community', '/settings'];

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Relative luminance per WCAG 2.1. */
function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [light, dark] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}

function parseRgb(value) {
  const match = value.match(/(\d+(?:\.\d+)?)/g);
  if (!match) return null;
  return match.slice(0, 3).map(Number);
}

for (const path of PAGES) {
  console.log(`\n${path}`);
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const metrics = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const heading = document.querySelector('h1');
    const headingStyle = heading ? getComputedStyle(heading) : null;
    const aside = document.querySelector('aside');
    const main = document.querySelector('main');
    return {
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
      fontFamily: body.fontFamily,
      textLength: (document.body.innerText || '').trim().length,
      headingText: heading?.textContent?.trim() ?? '',
      headingColor: headingStyle?.color ?? '',
      headingSize: headingStyle ? parseFloat(headingStyle.fontSize) : 0,
      asideBg: aside ? getComputedStyle(aside).backgroundColor : '',
      mainWidth: main ? main.getBoundingClientRect().width : 0,
      accentUsage: Array.from(document.querySelectorAll('*')).filter((element) => {
        const style = getComputedStyle(element);
        return (
          style.color === 'rgb(181, 233, 75)' ||
          style.backgroundColor === 'rgb(181, 233, 75)' ||
          style.borderColor === 'rgb(181, 233, 75)'
        );
      }).length,
      cardCount: document.querySelectorAll('.lab-card, .lab-panel').length,
      radiusValues: [
        ...new Set(
          Array.from(document.querySelectorAll('.lab-card')).map(
            (element) => getComputedStyle(element).borderRadius,
          ),
        ),
      ],
    };
  });

  check('renders content', metrics.textLength > 120, `text length ${metrics.textLength}`);
  check('has an h1', metrics.headingText.length > 0, metrics.headingText);
  check('h1 uses the display size', metrics.headingSize >= 20, `${metrics.headingSize}px`);
  check(
    'page background is the deep forest token',
    metrics.bodyBg === 'rgb(7, 27, 18)' || metrics.bodyBg === 'rgb(11, 29, 19)',
    metrics.bodyBg,
  );
  check(
    'uses the documented font stack',
    /Inter|Segoe UI|PingFang|YaHei/i.test(metrics.fontFamily),
    metrics.fontFamily,
  );
  check('accent colour is used sparingly, not everywhere', metrics.accentUsage > 0 && metrics.accentUsage < 260, `${metrics.accentUsage} elements`);
  check('cards use the small radius token', metrics.radiusValues.every((value) => value === '6px'), metrics.radiusValues.join(','));
  if (metrics.asideBg) {
    check('sidebar uses the surface token', metrics.asideBg === 'rgb(11, 29, 19)', metrics.asideBg);
  }
  check('main column is wide on desktop', metrics.mainWidth > 900, `${Math.round(metrics.mainWidth)}px`);

  // Contrast of body text against the page background.
  const fg = parseRgb(metrics.bodyColor);
  const bg = parseRgb(metrics.bodyBg);
  if (fg && bg) {
    const ratio = contrast(fg, bg);
    check('body text contrast >= 7:1', ratio >= 7, `${ratio.toFixed(2)}:1`);
  }

  const headingFg = parseRgb(metrics.headingColor);
  if (headingFg && bg) {
    const ratio = contrast(headingFg, bg);
    check('heading contrast >= 7:1', ratio >= 7, `${ratio.toFixed(2)}:1`);
  }
}

// Reduced-motion support must be honoured.
console.log('\nreduced motion');
const reduced = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
const reducedPage = await reduced.newPage();
await reducedPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const duration = await reducedPage.evaluate(() => {
  const element = document.querySelector('.lab-card') || document.body;
  return getComputedStyle(element).transitionDuration;
});
// The stylesheet collapses durations to 0.001ms, which computes to "1e-06s"
// (or "0s" in some engines). Anything below 10ms means motion is suppressed.
const durationSeconds = parseFloat(duration) || 0;
check('transitions collapse under prefers-reduced-motion', durationSeconds < 0.01, duration);
await reduced.close();

// Dark-only colour scheme must be declared.
console.log('\ncolour scheme');
const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
check('declares a dark colour scheme', scheme.includes('dark'), scheme);

await browser.close();
console.log(`\n${failures === 0 ? 'All visual checks passed.' : `${failures} visual check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
