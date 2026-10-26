import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TEACHER, evidenceDir } from './support';

/**
 * The acceptance slice, at the three viewports the product must hold up in (B6, R-10).
 *
 * One script, run on 390×844 (phone), 1280×720 (classroom projector) and 1024×768
 * (classroom tablet): visitor is bounced → signs in → catalog → experiment → interact →
 * favorite → my library → sign out. Each step is asserted and the viewport is
 * screenshotted, so the evidence is a picture someone can check.
 *
 * It uses a fresh browser context (no saved session) on purpose: the sign-in step must be
 * real, not a pre-seeded cookie.
 */
const STAGE = 'b6';
const VIEWPORTS = new Set(['mobile-chromium', 'projector-chromium', 'tablet-chromium']);

test.describe('full acceptance flow', () => {
  test('sign in, experiment, favorite, my library, sign out', async ({ browser }, testInfo) => {
    test.skip(
      !VIEWPORTS.has(testInfo.project.name),
      'this slice runs on the three required viewports only',
    );

    const viewport =
      testInfo.project.name === 'mobile-chromium'
        ? { width: 390, height: 844 }
        : testInfo.project.name === 'projector-chromium'
          ? { width: 1280, height: 720 }
          : { width: 1024, height: 768 };
    const label = `${testInfo.project.name}-${String(viewport.width)}x${String(viewport.height)}`;

    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:3220',
      viewport,
      locale: 'en-US',
      // A genuinely clean jar: this flow must start as a visitor, not with a saved session.
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();

    const dir = evidenceDir(STAGE);
    await mkdir(dir, { recursive: true });
    const shot = async (name: string): Promise<void> => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(dir, `${label}-${name}.png`), fullPage: false });
    };
    const noHorizontalScroll = async (): Promise<boolean> =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    try {
      // 1. A visitor is bounced to the login page, with the target remembered.
      await page.goto('/experiments/math-functions?lang=en');
      await expect(page).toHaveURL(/\/login\?next=/);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await shot('gate');

      // 2. Sign in through the form: the remembered target is opened, not the catalog.
      await page.getByTestId('auth-identifier').fill(TEACHER.identifier);
      await page.getByTestId('auth-password').fill(TEACHER.password);
      await page.getByTestId('auth-submit').click();
      await expect(page.getByTestId('formula')).toHaveText('y = x²');
      await expect(page).toHaveURL(/\/experiments\/math-functions/);

      // 3. The catalog is served by the API and fits the viewport.
      await page.getByTestId('back-button').click();
      await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();
      await expect(page.getByTestId('result-count')).toHaveText('1 experiment');
      expect(await noHorizontalScroll()).toBe(true);
      await shot('catalog');

      // 4. Open the experiment again and make it show something only a working model produces.
      await page
        .getByTestId('experiment-card-math-functions')
        .getByRole('link', { name: /start experiment/i })
        .click();
      await expect(page.getByTestId('formula')).toHaveText('y = x²');
      expect(await noHorizontalScroll()).toBe(true);

      await page.locator('#coef-a').fill('2');
      await page.locator('#coef-b').fill('-4');
      await expect(page.getByTestId('formula')).toHaveText('y = 2x² − 4x');
      await expect(page.getByTestId('readout-vertex')).toContainText('(1, -2)');
      expect(await noHorizontalScroll()).toBe(true);
      await shot('experiment');

      // 5. Favorite it; see it in "my library" together with the recent-use entry.
      const favorite = page.getByTestId('favorite-button');
      await expect(favorite).toBeVisible();
      if ((await favorite.textContent()) === 'Add to favorites') {
        await favorite.click();
      }
      await expect(favorite).toHaveText('Remove from favorites');

      await page.getByRole('link', { name: 'My library' }).click();
      await expect(
        page.getByTestId('favorites-list').getByTestId('item-math-functions'),
      ).toBeVisible();
      await expect(page.getByTestId('recent-list').getByTestId('item-math-functions')).toBeVisible();
      expect(await noHorizontalScroll()).toBe(true);
      await shot('my-library');

      // 6. Reload: both lists are server-side, so they survive a fresh page load.
      await page.reload();
      await expect(
        page.getByTestId('favorites-list').getByTestId('item-math-functions'),
      ).toBeVisible();

      // 7. Sign out; the protected page redirects again.
      await page.getByTestId('logout-button').click();
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await page.goto('/me?lang=en');
      await expect(page).toHaveURL(/\/login\?next=%2Fme/);
      await shot('signed-out');

      // 8. Leave the account clean for a repeated run.
      await page.goto('/login?lang=en');
      await page.getByTestId('auth-identifier').fill(TEACHER.identifier);
      await page.getByTestId('auth-password').fill(TEACHER.password);
      await page.getByTestId('auth-submit').click();
      await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();
      await page.goto('/me?lang=en');
      const remove = page.getByTestId('favorites-list').getByTestId('remove-math.functions');
      if ((await remove.count()) > 0) {
        await remove.click();
        await expect(page.getByTestId('favorites-empty')).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });
});
