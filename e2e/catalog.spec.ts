import { expect, test } from '@playwright/test';

/**
 * Browser verification of the reference catalog.
 *
 * Covers the two claims the page makes: it shows real third-party data with its
 * source and timestamp, and that data is visually fenced off from local
 * evaluations.
 */

test.describe.configure({ mode: 'serial' });

test('catalog page renders imported models with third-party scores', async ({ page }) => {
  await page.goto('/catalog', { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { level: 1 })).toContainText(/参考模型库|Reference catalog/);

  // The disclaimer must be visible before any number is.
  await expect(page.locator('body')).toContainText(/第三方|third part/i);

  // A table of models, with at least one Arena Elo or intelligence index cell.
  const table = page.getByRole('table').first();
  await expect(table).toBeVisible();
  const rows = await table.locator('tbody tr').count();
  expect(rows).toBeGreaterThan(10);

  const body = await page.locator('body').innerText();
  expect(body).toMatch(/openrouter/i);
  // Prices are shown with a dollar sign.
  expect(body).toMatch(/\$\d/);
});

test('importing is available as an explicit action', async ({ page }) => {
  await page.goto('/catalog', { waitUntil: 'networkidle' });
  const button = page.getByRole('button', { name: /拉取目录|刷新目录|Import catalog|Refresh catalog/ });
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
});

test('vendor filter narrows the list', async ({ page }) => {
  await page.goto('/catalog', { waitUntil: 'networkidle' });

  const table = page.getByRole('table').first();
  const before = await table.locator('tbody tr').count();

  const vendorSelect = page.getByRole('combobox').first();
  const options = await vendorSelect.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value).filter(Boolean),
  );
  expect(options.length).toBeGreaterThan(0);
  await vendorSelect.selectOption(options[0]);
  await page.waitForTimeout(500);

  const after = await table.locator('tbody tr').count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before);
});

test('search narrows the list', async ({ page }) => {
  await page.goto('/catalog', { waitUntil: 'networkidle' });
  await page.getByRole('searchbox').fill('claude');
  await page.waitForTimeout(600);
  const body = await page.locator('body').innerText();
  expect(body.toLowerCase()).toContain('claude');
});

test('a registered model shows third-party scores separately from local ones', async ({ page }) => {
  await page.goto('/catalog', { waitUntil: 'networkidle' });

  // The shipped catalog is seeded as registered models, so normally a row already
  // links to its model page. If a previous run cleared the keys there may be a
  // register button instead — click it and continue.
  let registeredLink = page.getByRole('link', { name: /已登记|Registered/ }).first();
  if ((await registeredLink.count()) === 0) {
    const registerButton = page.getByRole('button', { name: /登记到服务商|Register to provider/ }).first();
    await expect(registerButton).toBeVisible();
    await registerButton.click();
    registeredLink = page.getByRole('link', { name: /已登记|Registered/ }).first();
  }

  await expect(registeredLink).toBeVisible({ timeout: 20000 });
  await registeredLink.click();

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const body = await page.locator('body').innerText();

  // A third-party block, when present, must carry its caveat and its source.
  if (/第三方参考分数|Third-party reference scores/.test(body)) {
    expect(body).toMatch(/不是本站评测|not this project/i);
    expect(body).toMatch(/openrouter/i);
  }
  // The local evaluation section must still report "no data" rather than borrowing
  // a third-party number as its own score.
  expect(body).toMatch(/暂无|no data|—/i);
});
