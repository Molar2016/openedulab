import { expect, test, type Page } from '@playwright/test';

import { SECOND_STATE, shot } from './support';

/**
 * Saved parameter snapshots (design §7.5, R-17/R-18) against the real server.
 *
 * The point of this spec is the product promise, not the wiring: nothing is stored until
 * the user clicks save, a stored snapshot is applied only when the user asks for it, it
 * survives a reload, and another account cannot see it.
 */

const STAGE = 'b7';
const ORIGIN = 'http://127.0.0.1:3220';

async function clearSnapshot(page: Page): Promise<void> {
  const response = await page.request.delete('/api/me/saved-state/math.functions', {
    headers: { origin: ORIGIN },
  });
  expect(response.status()).toBe(204);
}

/** Moves the slope slider with the keyboard — 0.1 per press, the declared step. */
async function nudgeSlope(page: Page, presses: number): Promise<void> {
  const slider = page.getByLabel(/a \(slope/);
  await slider.focus();
  for (let index = 0; index < presses; index += 1) {
    await slider.press('ArrowRight');
  }
}

test.describe('saved settings', () => {
  test('are written only on an explicit save, survive a reload and restore on request', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one full flow, desktop');

    await page.goto('/experiments/math-functions?lang=en');
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await clearSnapshot(page);
    await page.reload();

    // Nothing stored: the restore button is not offered at all.
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page.getByTestId('save-state-button')).toBeVisible();
    await expect(page.getByTestId('restore-state-button')).toHaveCount(0);

    // Sliding alone must not write anything.
    await nudgeSlope(page, 20);
    await expect(page.getByTestId('formula')).toHaveText('y = 3x²');
    const untouched = await page.request.get('/api/me/saved-state/math.functions');
    expect(untouched.status()).toBe(404);

    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);

    const stored = await page.request.get('/api/me/saved-state/math.functions');
    expect(stored.status()).toBe(200);
    const body = (await stored.json()) as {
      contentVersion: string;
      stateSchemaVersion: number;
      values: Record<string, number | string>;
    };
    expect(body.contentVersion).toBe('1.0.0');
    expect(body.stateSchemaVersion).toBe(1);
    expect(body.values.mode).toBe('quadratic');
    expect(Number(body.values.a)).toBeCloseTo(3, 6);
    await shot(page, STAGE, 'saved-state-saved');

    // After a reload the page is back on the documented defaults — the snapshot is offered,
    // not applied.
    await page.reload();
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page.getByTestId('restore-state-button')).toBeVisible();
    await shot(page, STAGE, 'saved-state-offered');

    await page.getByTestId('restore-state-button').click();
    await expect(page.getByTestId('formula')).toHaveText('y = 3x²');
    await expect(page.getByLabel(/a \(slope/)).toHaveValue(/^3(\.0+)?$/);
    await shot(page, STAGE, 'saved-state-restored');

    // Deleting is real: afterwards the page reports nothing stored.
    await page.getByTestId('delete-state-button').click();
    await expect(page.getByTestId('restore-state-button')).toHaveCount(0);
    const afterDelete = await page.request.get('/api/me/saved-state/math.functions');
    expect(afterDelete.status()).toBe(404);
  });

  test('are invisible to another ordinary account', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'two contexts, one run');

    const ownerContext = await browser.newContext({ baseURL: ORIGIN, storageState: 'test-results/e2e/.auth/teacher.json' });
    const otherContext = await browser.newContext({ baseURL: ORIGIN, storageState: SECOND_STATE });
    const owner = await ownerContext.newPage();
    const other = await otherContext.newPage();

    try {
      // The owner stores a distinctive snapshot.
      await owner.goto('/experiments/math-functions?lang=en');
      await expect(owner.getByTestId('formula')).toHaveText('y = x²');
      await clearSnapshot(owner);
      await owner.reload();
      await nudgeSlope(owner, 10);
      await expect(owner.getByTestId('formula')).toHaveText('y = 2x²');
      await owner.getByTestId('save-state-button').click();
      await expect(owner.getByTestId('saved-state-notice')).toHaveText(/saved/i);

      // The other account sees defaults, is offered no snapshot, and gets 404 from the API.
      await other.goto('/experiments/math-functions?lang=en');
      await expect(other.getByTestId('formula')).toHaveText('y = x²');
      await expect(other.getByTestId('restore-state-button')).toHaveCount(0);
      const otherRead = await other.request.get('/api/me/saved-state/math.functions');
      expect(otherRead.status()).toBe(404);

      // Its delete is a no-op and the owner keeps the snapshot.
      const otherDelete = await other.request.delete('/api/me/saved-state/math.functions', {
        headers: { origin: ORIGIN },
      });
      expect(otherDelete.status()).toBe(204);
      const ownerRead = await owner.request.get('/api/me/saved-state/math.functions');
      expect(ownerRead.status()).toBe(200);
      await shot(owner, STAGE, 'saved-state-owner');
    } finally {
      await ownerContext.close();
      await otherContext.close();
    }
  });

  test('work on a phone viewport without horizontal scrolling', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone layout only');

    await page.goto('/experiments/math-functions?lang=en');
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await clearSnapshot(page);
    await page.reload();

    await nudgeSlope(page, 10);
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, STAGE, 'saved-state-mobile');
  });
});

test.describe('saved settings require a session', () => {
  test('anonymous callers are refused', async ({ playwright }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one run');

    // `storageState` is unset explicitly: a request context created from the `playwright`
    // fixture otherwise inherits the signed-in state of the project, which is exactly what
    // this test must not have.
    const anonymous = await playwright.request.newContext({
      baseURL: ORIGIN,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const read = await anonymous.get('/api/me/saved-state/math.functions');
      expect(read.status()).toBe(401);
      const write = await anonymous.put('/api/me/saved-state/math.functions', {
        data: { stateSchemaVersion: 1, values: { mode: 'linear', a: 1, b: 0, c: 0 } },
        headers: { origin: ORIGIN },
      });
      expect(write.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });
});
