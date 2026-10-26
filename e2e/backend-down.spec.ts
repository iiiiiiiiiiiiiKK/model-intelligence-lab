import { expect, test } from '@playwright/test';

/**
 * Regression test for the "HTTP_500" report.
 *
 * The Vite dev proxy answers `500` with an empty body when the API process is
 * not running. Before this was fixed the UI surfaced that as a generic
 * `HTTP_500`, which reads like an application bug. The client now maps a
 * bodyless 5xx to `BACKEND_UNAVAILABLE` with an instruction to start the server.
 *
 * The API is intentionally stopped for this file; Playwright's own webServer
 * config keeps only the Vite dev server alive because the API health check URL is
 * not required here.
 */

const API_BASE = 'http://127.0.0.1:8790';

test.describe.configure({ mode: 'serial' });

test('a bodyless 500 from the proxy is reported as backend-unavailable, not HTTP_500', async ({ page }) => {
  // Skip cleanly when the API is running: this scenario needs it stopped.
  const apiUp = await page.request
    .get(`${API_BASE}/api/health`, { failOnStatusCode: false, timeout: 3000 })
    .then((response) => response.ok())
    .catch(() => false);

  test.skip(apiUp, 'API is running; start the dev server with only Vite to exercise this path');

  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/models', { waitUntil: 'domcontentloaded' });

  // The friendly, actionable message must be shown.
  await expect(page.locator('body')).toContainText(
    /后端服务没有响应|backend is not responding/i,
    { timeout: 20000 },
  );

  // And the misleading raw code must not be what the user reads.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('HTTP_500');
  expect(body).not.toContain('Request failed with status 500');
});

test('retry button is offered for the backend-unavailable state', async ({ page }) => {
  const apiUp = await page.request
    .get(`${API_BASE}/api/health`, { failOnStatusCode: false, timeout: 3000 })
    .then((response) => response.ok())
    .catch(() => false);

  test.skip(apiUp, 'API is running; this path needs it stopped');

  await page.goto('/models', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /重试|Retry/ })).toBeVisible({ timeout: 20000 });
});
