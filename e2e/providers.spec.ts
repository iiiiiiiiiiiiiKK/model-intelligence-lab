import { expect, test, type Page } from '@playwright/test';

/**
 * Browser verification of the in-app provider management flow.
 *
 * This is the "no .env editing" path a first-time tester takes: open Settings,
 * add a relay with a key, test the connection, discover its models, register
 * them, and run an evaluation — all from the UI.
 *
 * The API runs with ALLOW_LOOPBACK_PROVIDER=true and a local stub serves the
 * OpenAI-compatible endpoints, so a real HTTP round trip happens.
 */

const STUB = 'http://127.0.0.1:8797/v1';
const STUB_KEY = 'stub-ui-verification-key-4321';
const ROTATED_KEY = 'stub-rotated-key-9999';
const NAME_PREFIX = 'UI relay';

test.describe.configure({ mode: 'serial' });

/**
 * A provider name unique per worker process and per run.
 *
 * Each Playwright project runs in its own worker process, and the module is
 * loaded fresh for each run — so `process.pid` plus a timestamp can never
 * collide with another project or with a leftover row from an interrupted
 * earlier attempt. It is module scope, so every serial test in this file sees
 * the same name. (Playwright requires hooks to destructure fixtures, and a hook
 * cannot receive `testInfo` in `beforeAll`, so this is simpler and stronger.)
 */
const providerName = `${NAME_PREFIX} ${process.pid} ${Date.now().toString(36)}`;

/** The card for our throwaway provider, scoped to avoid matching other rows. */
function providerCard(page: Page) {
  return page.locator('li', { hasText: providerName }).first();
}

test('adds a provider from the UI and tests the connection', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: /添加服务商|Add provider/ }).click();

  const form = page.locator('form').first();
  await expect(form).toBeVisible();

  await form.getByLabel(/名称|Name/).fill(providerName);
  await form.getByLabel(/接口地址|Base URL/).fill(STUB);
  await form.getByLabel(/API Key/).fill(STUB_KEY);

  // Submit inside the form; the page also has a generic "保存" button lower down.
  await form.getByRole('button', { name: /添加服务商|Add provider/ }).click();

  const card = providerCard(page);
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('••••4321');
  await expect(card).not.toContainText(STUB_KEY);

  // A real connectivity probe against the stub.
  await card.getByRole('button', { name: /测试连接|Test connection/ }).click();
  await expect(card).toContainText(/连接成功|Connected/, { timeout: 25000 });
  await expect(card).toContainText(/stub-model/);
});

test('discovers and registers models for the new provider', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const card = providerCard(page);
  await expect(card).toBeVisible({ timeout: 20000 });

  await card.getByRole('button', { name: /拉取模型列表|Fetch models/ }).click();
  await expect(card).toContainText(/stub-model/, { timeout: 25000 });

  const registerButton = card.getByRole('button', { name: /全部登记|Register all/ });
  await expect(registerButton).toBeEnabled();
  await registerButton.click();

  // The provider's model count in the card is refreshed after the write, and
  // the discovered list marks the model as registered — both are deterministic
  // signals that the registration actually landed.
  await expect(card).toContainText(/1 个模型|1 models/, { timeout: 25000 });
  await expect(card).toContainText(/已登记|Registered|stub-model/, { timeout: 25000 });
});

test('the registered model is usable in the lab', async ({ page }) => {
  await page.goto('/lab', { waitUntil: 'networkidle' });

  const modelSelect = page.getByRole('combobox').first();
  const options = await modelSelect.locator('option').allTextContents();
  // Other providers may also serve a model literally called `stub-model` (left
  // over from an earlier run, possibly without a key). Pick the one belonging to
  // this run's provider, which is the only one guaranteed to have a key.
  const target = options.find((text) => text.includes('stub-model') && text.includes(providerName));
  expect(target, `this run's stub-model should be selectable, saw: ${options.join(' | ')}`).toBeTruthy();

  await modelSelect.selectOption({ label: target! });

  const runButton = page.getByRole('button', { name: /确认并开始评测|Confirm and run/ });
  await expect(runButton).toBeEnabled({ timeout: 20000 });

  await page.locator('input[type="number"]').first().fill('3');
  await runButton.click();

  await expect(page.locator('body')).toContainText(/已完成|Completed/, { timeout: 120000 });
  await expect(page.locator('body')).toContainText(/评测结果|Results/);
});

test('editing the key keeps it masked and updates the hint', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const card = providerCard(page);
  await expect(card).toBeVisible({ timeout: 20000 });

  await card.getByRole('button', { name: /^编辑$|^Edit$/ }).click();
  const editForm = card.locator('form').first();
  await expect(editForm).toBeVisible();
  await editForm.getByLabel(/API Key/).fill(ROTATED_KEY);
  await editForm.getByRole('button', { name: /^保存$|^Save$/ }).click();

  await expect(card).toContainText('••••9999', { timeout: 20000 });
  await expect(card).not.toContainText(ROTATED_KEY);
});

test('clearing the key disables evaluation honestly', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const card = providerCard(page);
  await expect(card).toBeVisible({ timeout: 20000 });

  await card.getByRole('button', { name: /^编辑$|^Edit$/ }).click();
  const editForm = card.locator('form').first();
  await expect(editForm).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await editForm.getByRole('button', { name: /清除密钥|Clear key/ }).click();

  await expect(card).toContainText(/未配置|Not configured/, { timeout: 20000 });
});

test('the key never appears in the page source', async ({ page }) => {
  await page.goto('/settings', { waitUntil: 'networkidle' });
  const card = providerCard(page);
  await expect(card).toBeVisible({ timeout: 20000 });

  // Make sure a key is actually stored, so the "masked" assertion below cannot
  // pass vacuously on a card that simply has no key.
  await card.getByRole('button', { name: /^编辑$|^Edit$/ }).click();
  const editForm = card.locator('form').first();
  await expect(editForm).toBeVisible();
  await editForm.getByLabel(/API Key/).fill(STUB_KEY);
  await editForm.getByRole('button', { name: /^保存$|^Save$/ }).click();
  await expect(card).toContainText('••••4321', { timeout: 20000 });

  const html = await page.content();
  expect(html).not.toContain(STUB_KEY);
  expect(html).not.toContain(ROTATED_KEY);

  // Nor in any API response the page can read.
  const apiBody = await page.evaluate(async () => {
    const response = await fetch('/api/providers');
    return response.text();
  });
  expect(apiBody).not.toContain(STUB_KEY);
  expect(apiBody).not.toContain(ROTATED_KEY);
  expect(apiBody).toContain('••••');
});
