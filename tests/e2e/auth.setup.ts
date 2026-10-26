import { expect, test as setup } from '@playwright/test';
import { SECOND_STATE, SECOND_TEACHER, TEACHER } from './support';

/**
 * Registers the shared accounts once per run and saves their session cookies, so the
 * behavioural specs do not each spend a registration (the API allows 5 per hour per IP,
 * and that limit is deliberately not loosened for tests).
 *
 * Two accounts, because "another ordinary account cannot see my data" is a product
 * requirement and needs a real second identity. The e2e server starts from an empty
 * database, so both exist only for this run.
 */
const TEACHER_STATE = 'test-results/e2e/.auth/teacher.json';

setup('register the shared teacher account', async ({ page }) => {
  await page.goto('/register?lang=en');
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();

  await page.getByTestId('auth-identifier').fill(TEACHER.identifier);
  await page.getByTestId('auth-password').fill(TEACHER.password);
  await page.getByTestId('auth-submit').click();

  // Registration creates a session server-side; the app then opens the catalog.
  await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();
  await expect(page.getByTestId('account-block')).toContainText('e***@example.com');

  await page.context().storageState({ path: TEACHER_STATE });
});

setup('register a second account for isolation checks', async ({ page }) => {
  await page.goto('/register?lang=zh-CN');
  await expect(page.getByRole('heading', { name: '注册账号' })).toBeVisible();

  await page.getByTestId('auth-identifier').fill(SECOND_TEACHER.identifier);
  await page.getByTestId('auth-password').fill(SECOND_TEACHER.password);
  await page.getByTestId('auth-submit').click();

  await expect(page.getByRole('heading', { name: '选择一个实验' })).toBeVisible();
  await page.context().storageState({ path: SECOND_STATE });
});
