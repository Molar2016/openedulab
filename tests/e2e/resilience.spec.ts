import { expect, test } from '@playwright/test';
import { shot, TEACHER } from './support';

/**
 * Failure paths in a real browser (B6, R-16 and the revoked-session case).
 *
 * Two things must be true when the network or the session is not cooperating:
 * 1. a failed API call shows an honest error with a retry, never a blank page or a
 *    fabricated list;
 * 2. a session revoked elsewhere stops working on the next request, because the server
 *    decides — not a timer in the tab.
 *
 * The revocation test signs in to its *own* session on purpose: revoking the session other
 * specs share would make this file depend on execution order.
 */
const STAGE = 'b6';
const ORIGIN_HEADERS = { origin: 'http://127.0.0.1:3220', 'content-type': 'application/json' };

test.describe('resilience', () => {
  test('a failed catalog call shows an error, and retry recovers', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough here');

    await page.route('**/api/catalog*', (route) => route.abort('failed'));

    await page.goto('/?lang=en');
    await expect(page.getByTestId('catalog-error')).toBeVisible();
    await expect(page.getByTestId('experiment-card-math-functions')).toHaveCount(0);
    await shot(page, STAGE, 'resilience-catalog-offline');

    await page.unroute('**/api/catalog*');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('experiment-card-math-functions')).toBeVisible();
    await expect(page.getByTestId('catalog-error')).toHaveCount(0);
  });

  test('a session revoked elsewhere is rejected on the next navigation', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough here');

    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:3220',
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      const login = await page.request.post('/api/auth/login', {
        headers: ORIGIN_HEADERS,
        data: { loginKind: 'email', identifier: TEACHER.identifier, password: TEACHER.password },
      });
      expect(login.status()).toBe(200);

      await page.goto('/experiments/math-functions?lang=en');
      await expect(page.getByTestId('formula')).toHaveText('y = x²');

      // Revoke this session the way "sign out on another device" would: the server row.
      const logout = await page.request.post('/api/auth/logout', {
        headers: ORIGIN_HEADERS,
        data: {},
      });
      expect(logout.status()).toBe(204);

      // Reloading the still-open tab must not keep working.
      await page.reload();
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

      const afterRevocation = await page.request.get('/api/me/favorites');
      expect(afterRevocation.status()).toBe(401);
    } finally {
      await context.close();
    }
  });

  test('the login form is usable with the keyboard alone', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one browser is enough here');

    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:3220',
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      await page.goto('/login?lang=en');
      await page.getByTestId('auth-identifier').focus();
      await page.keyboard.type('keyboard@example.com');
      await page.keyboard.press('Tab');
      await page.keyboard.type('a password with spaces');
      await page.keyboard.press('Enter');

      // The credentials are wrong, but the form submitted: focus was reachable and Enter
      // submitted it, with no mouse involved.
      await expect(page.getByTestId('auth-error')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
