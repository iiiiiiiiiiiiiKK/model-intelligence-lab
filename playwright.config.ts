import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end browser verification.
 *
 * The suite boots the real API server and the real Vite dev server; nothing is
 * mocked. `webServer` waits for both before the first test runs.
 *
 * Browser selection: Playwright's bundled Chromium is not downloaded in this
 * environment, so the config uses the locally installed Microsoft Edge via the
 * `msedge` channel. Set PLAYWRIGHT_CHANNEL=chromium after running
 * `npx playwright install chromium` to use the bundled browser instead.
 */
const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'artifacts/playwright-report' }]],
  outputDir: 'artifacts/playwright-results',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...(channel ? { channel } : { channel: 'msedge' }),
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://127.0.0.1:8790/api/health',
      reuseExistingServer: true,
      timeout: 90_000,
      env: {
        NODE_ENV: 'development',
        PORT: '8790',
        HOST: '127.0.0.1',
        // The provider-management suite adds a provider pointing at a local stub
        // so the full UI -> engine path can be verified without a paid key.
        ALLOW_LOOPBACK_PROVIDER: 'true',
        // The browser suite is far chattier than a human (dozens of page loads
        // per minute, each fanning out several API calls). The production
        // default of 240/min would throttle the test run itself, so the limit is
        // raised here rather than weakening the shipped default.
        RATE_LIMIT_MAX_REQUESTS: '20000',
      },
    },
    {
      command: 'node scripts/stub-provider.mjs 8797',
      url: 'http://127.0.0.1:8797/v1/models',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev:web',
      url: 'http://127.0.0.1:5199',
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
});
