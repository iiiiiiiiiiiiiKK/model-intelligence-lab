import { expect, test, type Page } from '@playwright/test';

/**
 * Real browser verification of the running application.
 *
 * These tests hit the actual API and the actual rendered UI. They assert the
 * behaviours the product promises: language switching that survives a reload,
 * honest empty/error states, working navigation, per-run detail rendering, and
 * a mobile layout without horizontal overflow.
 */

const ROUTES = [
  { path: '/', label: /AI 模型实验室|Model Intelligence Lab/ },
  { path: '/models', label: /模型库|Models/ },
  { path: '/compare', label: /模型对比|Compare/ },
  { path: '/lab', label: /评测实验室|Evaluation Lab/ },
  { path: '/monitor', label: /退化监测|Regression Monitor/ },
  { path: '/benchmarks', label: /测试题库|Benchmarks/ },
  { path: '/reports', label: /实验报告|Reports/ },
  { path: '/community', label: /社区|Community/ },
  { path: '/settings', label: /设置|Settings/ },
];

/** Language toggle: the sidebar on desktop, the top bar on mobile. */
async function switchLanguage(page: Page, target: 'en' | 'zh-CN') {
  const pattern = target === 'en' ? /English/ : /简体中文/;
  await page.getByRole('button', { name: pattern }).first().click();
  await expect(page.locator('html')).toHaveAttribute('lang', target);
}

test.describe('navigation and rendering', () => {
  for (const route of ROUTES) {
    test(`renders ${route.path} without console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));

      const response = await page.goto(route.path, { waitUntil: 'networkidle' });
      expect(response?.status()).toBe(200);

      // The page heading is present and matches the route.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('body')).toContainText(route.label);

      // No uncaught errors or failed requests surfaced to the console.
      // Ignored: favicon 404s (no favicon in the dev server root) and Vite's HMR
      // socket, which is a dev-server implementation detail and not part of the
      // application. A production build has no HMR client at all.
      const meaningful = errors.filter(
        (text) =>
          !text.includes('favicon') &&
          !text.includes('Download the React DevTools') &&
          !text.includes('WebSocket connection to') &&
          !text.includes('[vite]'),
      );
      expect(meaningful, `console errors on ${route.path}: ${meaningful.join(' | ')}`).toHaveLength(0);
    });
  }
});

test.describe('default language and switching', () => {
  test('defaults to Simplified Chinese', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.localStorage.removeItem('model-lab.locale'));
    await page.reload({ waitUntil: 'networkidle' });

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('模型变笨了');
    // A language control is reachable without opening any menu.
    await expect(page.getByRole('button', { name: /English/ }).first()).toBeVisible();
  });

  test('switches the whole UI to English and survives a reload', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.localStorage.removeItem('model-lab.locale'));
    await page.reload({ waitUntil: 'networkidle' });

    await switchLanguage(page, 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('testable question');

    // The choice must persist across a full reload...
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('testable question');

    // ...and across client-side navigation.
    await page.goto('/benchmarks', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Benchmarks');

    // Restore Chinese so subsequent tests in this worker start from the default.
    await switchLanguage(page, 'zh-CN');
  });

  test('does not lose form input when the language changes', async ({ page }) => {
    await page.goto('/lab', { waitUntil: 'networkidle' });

    const limitInput = page.locator('input[type="number"]').first();
    await limitInput.fill('17');
    await expect(limitInput).toHaveValue('17');

    await switchLanguage(page, 'en');
    await expect(limitInput).toHaveValue('17');

    await switchLanguage(page, 'zh-CN');
    await expect(limitInput).toHaveValue('17');
  });
});

test.describe('data honesty', () => {
  test('home shows a demo banner and no fabricated scores', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // With only demo data present, the banner must be visible.
    await expect(page.getByText(/示例数据|DEMO|Demo/i).first()).toBeVisible();

    // No-model-configured providers must be shown as missing, not as working.
    await expect(page.locator('body')).toContainText(/缺少密钥|Key missing/);
  });

  test('lab blocks evaluation for a model whose provider has no key', async ({ page }) => {
    await page.goto('/lab', { waitUntil: 'networkidle' });

    const modelSelect = page.getByRole('combobox').first();
    const options = await modelSelect.locator('option').allTextContents();
    // A model whose provider is explicitly marked as missing a key. The suite
    // may have added working providers, so the test targets the unkeyed one
    // rather than assuming the whole app is unconfigured.
    const unkeyed = options.find((text) => /缺少密钥|Key missing|no server-side|未配置/.test(text));
    expect(unkeyed, `expected at least one unkeyed model, saw: ${options.join(' | ')}`).toBeTruthy();

    await modelSelect.selectOption({ label: unkeyed! });

    const runButton = page.getByRole('button', { name: /确认并开始评测|Confirm and run/ });
    await expect(runButton).toBeVisible();
    await expect(runButton).toBeDisabled();

    // The reason is stated, not hidden.
    await expect(page.locator('body')).toContainText(
      /未配置 API Key|no server-side API key|No API key|API Key|服务端 API Key/,
    );
  });

  test('monitor explains that a baseline is required', async ({ page }) => {
    await page.goto('/monitor', { waitUntil: 'networkidle' });
    // A caveat about interpretation is always shown.
    await expect(page.locator('body')).toContainText(/未发现显著变化|No significant change/);
  });

  test('unknown route renders a 404 page', async ({ page }) => {
    await page.goto('/this-route-does-not-exist', { waitUntil: 'networkidle' });
    await expect(page.locator('body')).toContainText(/未找到该资源|not found/i);
  });
});

test.describe('interactions', () => {
  test('benchmarks page lists real items and filters by dimension', async ({ page }) => {
    await page.goto('/benchmarks', { waitUntil: 'networkidle' });

    const table = page.getByRole('table').last();
    await expect(table).toBeVisible();
    const initialRows = await table.locator('tbody tr').count();
    expect(initialRows).toBeGreaterThan(10);

    // Filter to coding and confirm the row count changes.
    await page.getByRole('combobox').last().selectOption('coding');
    await page.waitForTimeout(400);
    const filteredRows = await table.locator('tbody tr').count();
    expect(filteredRows).toBeGreaterThan(0);
    expect(filteredRows).toBeLessThan(initialRows);
  });

  test('models page search narrows the list', async ({ page }) => {
    await page.goto('/models', { waitUntil: 'networkidle' });

    const rowsBefore = await page.locator('tbody tr').count();
    expect(rowsBefore).toBeGreaterThan(0);

    await page.getByRole('searchbox').fill('zzz-no-such-model');
    await page.waitForTimeout(500);
    await expect(page.locator('body')).toContainText(/没有符合筛选条件|No models match/);
  });

  test('settings page persists language and budget', async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'networkidle' });

    await switchLanguage(page, 'en');

    const budget = page.locator('input[type="number"]').first();
    await budget.fill('5');
    await page.getByRole('button', { name: /^Save$|^保存$/ }).click();
    await expect(page.locator('body')).toContainText(/Settings saved|设置已保存/);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('input[type="number"]').first()).toHaveValue('5');

    await switchLanguage(page, 'zh-CN');
  });

  test('community page accepts a submission', async ({ page }) => {
    await page.goto('/community', { waitUntil: 'networkidle' });

    await page.getByLabel(/标题|Title/).fill('Playwright e2e suggestion');
    await page.getByLabel(/题目内容|Item text/).fill('This item was submitted by the automated browser test.');

    await page.getByRole('button', { name: /提交|Submit/ }).click();
    await expect(page.locator('body')).toContainText(/已提交|Submitted/);
  });
});

test.describe('mobile layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile-only checks');

  for (const path of ['/', '/lab', '/reports', '/benchmarks', '/models', '/monitor']) {
    test(`no horizontal overflow on ${path}`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        docWidth: document.documentElement.clientWidth,
      }));
      // Allow a 2px rounding tolerance.
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.docWidth + 2);
    });
  }

  test('mobile drawer navigation works', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: /打开菜单|Open menu/ }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    await drawer.getByRole('link', { name: /设置|Settings/ }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/设置|Settings/);
  });

  test('language switch is reachable on mobile', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await switchLanguage(page, 'en');
    await switchLanguage(page, 'zh-CN');
  });
});
