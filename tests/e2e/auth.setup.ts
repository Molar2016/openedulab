import { expect, test as setup } from '@playwright/test';
import { TEACHER } from './support';

/**
 * Registers the shared test account once per run and saves its session cookie, so the
 * behavioural specs do not each spend a registration (the API allows 5 per hour per IP,
 * and that limit is deliberately not loosened for tests).
 *
 * The e2e server starts from an empty database, so this account exists only for this run.
 */
const STATE = 'test-results/e2e/.auth/teacher.json';

setup('register the shared teacher account', async ({ page }) => {
  await page.goto('/register?lang=en');
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();

  await page.getByTestId('auth-identifier').fill(TEACHER.identifier);
  await page.getByTestId('auth-password').fill(TEACHER.password);
  await page.getByTestId('auth-submit').click();

  // Registration creates a session server-side; the app then opens the catalog.
  await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();
  await expect(page.getByTestId('account-block')).toContainText('e***@example.com');

  await page.context().storageState({ path: STATE });
});
