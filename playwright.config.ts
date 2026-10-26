import { defineConfig, devices } from '@playwright/test';

/**
 * Local E2E. The app under test is the real API process serving the real built SPA
 * (`scripts/e2e-server.mjs`), not the Vite dev server: B3 makes the session gate part of
 * the deliverable, so the browser must exercise it.
 *
 * Specs write their own screenshots/video into docs/evidence/<stage>/; Playwright's
 * artefacts stay in test-results/.
 */
const STATE = 'test-results/e2e/.auth/teacher.json';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results/e2e/artifacts',
  use: {
    baseURL: 'http://127.0.0.1:3220',
    locale: 'en-US',
    trace: 'retain-on-failure',
    video: 'on',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 950 },
        storageState: STATE,
      },
      dependencies: ['setup'],
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], video: 'off', storageState: STATE },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:3220/api/healthz',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
