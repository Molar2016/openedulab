import { expect, test, type Page } from '@playwright/test';

import { shot } from './support';

/**
 * Curriculum contexts (ADR-003) against the real server and the real bundle.
 *
 * Two directory entries reuse ONE experiment. Each chapter opens with its own validated
 * preset, owns its own personal snapshot, and never inherits the tool-level one. The
 * entries are pilot examples and the page says so — the test asserts that label rather
 * than pretending these are textbook chapters.
 */

const STAGE = 'r7';
const ORIGIN = 'http://127.0.0.1:3220';
const CHAPTER_A = 'math.functions.pilot-linear-slope';
const CHAPTER_B = 'math.functions.pilot-quadratic-vertex';
const TOOL = 'math.functions';

async function clearToolSnapshot(page: Page): Promise<void> {
  const response = await page.request.delete(`/api/me/saved-state/${TOOL}`, {
    headers: { origin: ORIGIN },
  });
  expect(response.status()).toBe(204);
}

function overflowOf(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('curriculum directory and chapter entries', () => {
  test('lists both chapters, opens chapter A with its preset, saves, reloads and resets', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one full flow, desktop');

    await page.goto('/curriculum?lang=en');

    // Reachable by navigation, and honest about what the entries are.
    await expect(page.getByRole('heading', { name: 'Curriculum entries' })).toBeVisible();
    await expect(page.getByTestId('curriculum-entry-pilot-linear-slope')).toBeVisible();
    await expect(page.getByTestId('curriculum-entry-pilot-quadratic-vertex')).toBeVisible();
    await expect(page.getByTestId('curriculum-status-pilot-linear-slope')).toHaveText(
      /not a textbook chapter/i,
    );
    await expect(page.getByTestId('curriculum-entry-pilot-linear-slope')).toContainText(
      'Sample chapter A · slope and intercept',
    );
    await shot(page, STAGE, 'curriculum-directory');

    // Open chapter A through its link.
    await page
      .getByTestId('curriculum-entry-pilot-linear-slope')
      .getByRole('link', { name: /Slope and intercept of a linear function/i })
      .click();
    await expect(page).toHaveURL(new RegExp(`/curriculum/pilot-linear-slope`));
    await expect(page.getByTestId('placement-breadcrumb')).toContainText(
      'Sample chapter A · slope and intercept',
    );
    // "Back" from a chapter goes to the curriculum directory, not to the tool catalog.
    await expect(page.getByTestId('back-button')).toHaveText(/back to curriculum/i);

    // Preset from the chapter, not the tool default (which is a=1, b=0, quadratic).
    await expect(page.getByTestId('formula')).toHaveText('y = 2x + 3');
    await expect(page.locator('#coef-a')).toHaveValue(/^2(\.0+)?$/);
    await expect(page.locator('#coef-b')).toHaveValue(/^3(\.0+)?$/);
    await expect(page.getByTestId('parameter-origin')).toHaveText(/chapter preset/i);
    await expect(page.getByTestId('restore-state-button')).toHaveCount(0);
    await expect(page.getByTestId('delete-state-button')).toHaveCount(0);

    const chapterBefore = await page.request.get(`/api/me/placement-state/${CHAPTER_A}`);
    expect(chapterBefore.status()).toBe(404);

    // Change and save: this writes (account, placement), nothing else.
    await page.locator('#coef-a').fill('5');
    await expect(page.getByTestId('formula')).toHaveText('y = 5x + 3');
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);
    await expect(page.getByTestId('parameter-origin')).toHaveText(/your saved parameters/i);

    const stored = await page.request.get(`/api/me/placement-state/${CHAPTER_A}`);
    expect(stored.status()).toBe(200);
    const storedBody = (await stored.json()) as {
      placementId: string;
      placementVersion: number;
      contentVersion: string;
      values: Record<string, number | string>;
    };
    expect(storedBody.placementId).toBe(CHAPTER_A);
    expect(storedBody.placementVersion).toBe(1);
    expect(storedBody.contentVersion).toBe('1.0.0');
    expect(Number(storedBody.values.a)).toBeCloseTo(5, 6);
    await shot(page, STAGE, 'chapter-a-saved');

    // Re-entering the chapter applies the snapshot automatically.
    await page.reload();
    await expect(page.getByTestId('formula')).toHaveText('y = 5x + 3');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/your saved parameters/i);

    // Reset returns to the preset and keeps the snapshot.
    await page.getByTestId('reset-button').click();
    await expect(page.getByTestId('formula')).toHaveText('y = 2x + 3');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/chapter preset/i);
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/kept/i);
    const afterReset = await page.request.get(`/api/me/placement-state/${CHAPTER_A}`);
    expect(afterReset.status()).toBe(200);
    await shot(page, STAGE, 'chapter-a-reset-kept');

    // Saving after a reset overwrites this chapter's own snapshot.
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);
    const overwritten = await page.request.get(`/api/me/placement-state/${CHAPTER_A}`);
    expect(Number(((await overwritten.json()) as { values: { a: number } }).values.a)).toBeCloseTo(
      2,
      6,
    );
  });

  test('keeps chapter B, the direct tool entry and recent use in their own scopes', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one sequential flow, desktop');

    // Chapter B: its own preset, and none of chapter A's snapshot.
    await page.goto('/curriculum/pilot-quadratic-vertex?lang=en');
    await expect(page.getByTestId('formula')).toHaveText('y = x² − 2x');
    await expect(page.locator('#coef-b')).toHaveValue(/^-2(\.0+)?$/);
    await expect(page.getByTestId('parameter-origin')).toHaveText(/chapter preset/i);
    const chapterB = await page.request.get(`/api/me/placement-state/${CHAPTER_B}`);
    expect(chapterB.status()).toBe(404);
    await shot(page, STAGE, 'chapter-b-preset');

    // The direct tool entry is unchanged by any chapter snapshot: tool defaults first.
    await clearToolSnapshot(page);
    await page.goto('/experiments/math-functions?lang=en');
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/tool defaults/i);
    const toolScope = await page.request.get(`/api/me/saved-state/${TOOL}`);
    expect(toolScope.status()).toBe(404);
    await shot(page, STAGE, 'direct-defaults');

    // A tool-level snapshot is its own scope: saved here, absent for the chapters.
    const toolWrite = await page.request.put(`/api/me/saved-state/${TOOL}`, {
      data: {
        stateSchemaVersion: 1,
        values: { mode: 'quadratic', a: 4, b: 0, c: 0 },
      },
      headers: { origin: ORIGIN },
    });
    expect(toolWrite.status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId('formula')).toHaveText('y = 4x²');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/your saved parameters/i);

    const chapterA = await page.request.get(`/api/me/placement-state/${CHAPTER_A}`);
    expect(chapterA.status()).toBe(200);
    expect(Number(((await chapterA.json()) as { values: { a: number } }).values.a)).toBeCloseTo(
      2,
      6,
    );
    const chapterBStill = await page.request.get(`/api/me/placement-state/${CHAPTER_B}`);
    expect(chapterBStill.status()).toBe(404);

    // Recent use stays keyed by the tool, and the library opens the direct entry.
    await page.goto('/me?lang=en');
    const recentLinks = page.getByTestId('recent-list').getByRole('link');
    await expect(recentLinks.first()).toHaveAttribute(
      'href',
      new RegExp(`^/experiments/math-functions`),
    );
    await recentLinks.first().click();
    await expect(page).toHaveURL(new RegExp(`/experiments/math-functions`));
    await expect(page.getByTestId('placement-breadcrumb')).toHaveCount(0);

    // Leave the database clean for the specs that run after this one.
    await clearToolSnapshot(page);
  });

  test('reads well on a phone: no horizontal scrolling on the directory or a chapter', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone layout only');

    await page.goto('/curriculum?lang=en');
    await expect(page.getByTestId('curriculum-list')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);

    await page.goto('/curriculum/pilot-linear-slope?lang=en');
    await expect(page.getByTestId('formula')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);
    await shot(page, STAGE, 'chapter-mobile');
  });

  test('reports an unknown chapter instead of rendering something else', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one run');

    await page.goto('/curriculum/not-a-real-chapter?lang=en');
    await expect(page.getByTestId('placement-missing')).toBeVisible();
    await expect(page.getByTestId('formula')).toHaveCount(0);
  });
});
