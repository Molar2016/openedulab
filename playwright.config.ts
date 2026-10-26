import { defineConfig, devices } from '@playwright/test';

/**
 * Local M1 E2E. The dev server is either already running on 5199 or started here.
 * Evidence (screenshots, video) is written under docs/evidence/m1.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    locale: 'en-US',
    trace: 'retain-on-failure',
    video: 'on',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 950 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], video: 'off' },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 60_000,
    env: { VITE_OPENEDULAB_ANALYTICS: '1' },
  },
});
