import { expect, test, type Page } from '@playwright/test';

import { SECOND_STATE, shot } from './support';

/**
 * Direct tool entry: immediate, automatic loading of *this account's tool-level* snapshot
 * (ADR-003). The chapter-scoped counterpart lives in `curriculum.spec.ts`.
 *
 * The product promise under test: opening the page shows the tool's own defaults unless the
 * account saved something for the tool; the toolbar has exactly two parameter controls
 * (save, reset); reset changes the view but never deletes the stored snapshot.
 */

const STAGE = 'r7';
const ORIGIN = 'http://127.0.0.1:3220';
const TOOL = 'math.functions';

async function clearToolSnapshot(page: Page): Promise<void> {
  const response = await page.request.delete(`/api/me/saved-state/${TOOL}`, {
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

test.describe('saved settings on the direct tool entry', () => {
  test('are written only on save, load automatically next time, and survive reset', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one full flow, desktop');

    await page.goto(`/experiments/math-functions?lang=en`);
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await clearToolSnapshot(page);
    await page.reload();

    // Nothing stored for the tool: defaults, and only the two parameter controls.
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/tool defaults/i);
    await expect(page.getByTestId('save-state-button')).toBeVisible();
    await expect(page.getByTestId('restore-state-button')).toHaveCount(0);
    await expect(page.getByTestId('delete-state-button')).toHaveCount(0);

    // Sliding alone must not write anything.
    await nudgeSlope(page, 20);
    await expect(page.getByTestId('formula')).toHaveText('y = 3x²');
    const untouched = await page.request.get(`/api/me/saved-state/${TOOL}`);
    expect(untouched.status()).toBe(404);

    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);
    await expect(page.getByTestId('parameter-origin')).toHaveText(/your saved parameters/i);

    const stored = await page.request.get(`/api/me/saved-state/${TOOL}`);
    expect(stored.status()).toBe(200);
    const body = (await stored.json()) as {
      contentVersion: string;
      stateSchemaVersion: number;
      values: Record<string, number | string>;
    };
    expect(body.contentVersion).toBe('1.0.0');
    expect(body.stateSchemaVersion).toBe(1);
    expect(Number(body.values.a)).toBeCloseTo(3, 6);
    await shot(page, STAGE, 'direct-saved');

    // Reload: the stored snapshot is applied without any click.
    await page.reload();
    await expect(page.getByTestId('formula')).toHaveText('y = 3x²');
    await expect(page.getByLabel(/a \(slope/)).toHaveValue(/^3(\.0+)?$/);
    await expect(page.getByTestId('parameter-origin')).toHaveText(/your saved parameters/i);

    // Reset goes back to the tool defaults and does NOT delete the snapshot.
    await page.getByTestId('reset-button').click();
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/tool defaults/i);
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/kept/i);
    const afterReset = await page.request.get(`/api/me/saved-state/${TOOL}`);
    expect(afterReset.status()).toBe(200);
    await shot(page, STAGE, 'direct-reset-kept');

    // Saving again overwrites this account's own snapshot.
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);
    const overwritten = await page.request.get(`/api/me/saved-state/${TOOL}`);
    expect(overwritten.status()).toBe(200);
    expect(
      Number(((await overwritten.json()) as { values: { a: number } }).values.a),
    ).toBeCloseTo(1, 6);
  });

  test('are invisible to another ordinary account', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'two contexts, one run');

    const ownerContext = await browser.newContext({
      baseURL: ORIGIN,
      storageState: 'test-results/e2e/.auth/teacher.json',
    });
    const otherContext = await browser.newContext({ baseURL: ORIGIN, storageState: SECOND_STATE });
    const owner = await ownerContext.newPage();
    const other = await otherContext.newPage();

    try {
      await owner.goto('/experiments/math-functions?lang=en');
      await expect(owner.getByTestId('formula')).toHaveText('y = x²');
      await clearToolSnapshot(owner);
      await owner.reload();
      await nudgeSlope(owner, 10);
      await expect(owner.getByTestId('formula')).toHaveText('y = 2x²');
      await owner.getByTestId('save-state-button').click();
      await expect(owner.getByTestId('saved-state-notice')).toHaveText(/saved/i);

      // The other account gets defaults, no inherited snapshot, and a 404 from the API.
      await other.goto('/experiments/math-functions?lang=en');
      await expect(other.getByTestId('formula')).toHaveText('y = x²');
      await expect(other.getByTestId('parameter-origin')).toHaveText(/tool defaults/i);
      const otherRead = await other.request.get(`/api/me/saved-state/${TOOL}`);
      expect(otherRead.status()).toBe(404);
      await shot(other, STAGE, 'direct-other-account');
    } finally {
      await clearToolSnapshot(owner).catch(() => undefined);
      await ownerContext.close();
      await otherContext.close();
    }
  });

  test('work on a phone viewport without horizontal scrolling', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone layout only');

    await page.goto('/experiments/math-functions?lang=en');
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await clearToolSnapshot(page);
    await page.reload();

    await nudgeSlope(page, 10);
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, STAGE, 'direct-mobile');

    // This account is shared by every project; leaving a snapshot behind would change what
    // the next project sees when it opens the same experiment (auto-load is the new rule).
    await clearToolSnapshot(page);
  });
});

test.describe('parameter snapshots require a session', () => {
  test('anonymous callers are refused on both scopes', async ({ playwright }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one run');

    // `storageState` is unset explicitly: a request context created from the `playwright`
    // fixture otherwise inherits the signed-in state of the project, which is what this
    // test must not have.
    const anonymous = await playwright.request.newContext({
      baseURL: ORIGIN,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const read = await anonymous.get(`/api/me/saved-state/${TOOL}`);
      expect(read.status()).toBe(401);
      const write = await anonymous.put(`/api/me/saved-state/${TOOL}`, {
        data: { stateSchemaVersion: 1, values: { mode: 'linear', a: 1, b: 0, c: 0 } },
        headers: { origin: ORIGIN },
      });
      expect(write.status()).toBe(401);

      const chapterRead = await anonymous.get(
        '/api/me/placement-state/math.functions.pilot-linear-slope',
      );
      expect(chapterRead.status()).toBe(401);
      const directory = await anonymous.get('/api/curriculum');
      expect(directory.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });
});
