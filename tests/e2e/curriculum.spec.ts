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

const STAGE = 'r8';
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

    // Reachable by navigation, honest about what the entries are, and grouped as
    // 学科 → 教材 → 册 → 章 → 工具入口.
    await expect(page.getByRole('heading', { level: 1, name: 'Mathematics course' })).toBeVisible();
    await expect(page.getByTestId('curriculum-catalog-pilot-edition')).toBeVisible();
    await expect(page.getByTestId('curriculum-catalog-pilot-edition-b')).toBeVisible();
    await expect(page.getByTestId('curriculum-catalog-status-pilot-edition')).toHaveText(
      /not a textbook chapter/i,
    );
    await expect(page.getByTestId('curriculum-entry-pilot-linear-slope')).toBeVisible();
    await expect(page.getByTestId('curriculum-entry-pilot-quadratic-vertex')).toBeVisible();
    await expect(page.getByTestId('curriculum-status-pilot-linear-slope')).toHaveText(
      /not a textbook chapter/i,
    );
    await expect(page.getByTestId('curriculum-entry-pilot-linear-slope')).toContainText(
      'Sample chapter A · slope and intercept',
    );

    // Catalog A orders slope → vertex; catalog B orders vertex → slope for the same tool.
    const catalogAEntries = page
      .getByTestId('curriculum-catalog-pilot-edition')
      .getByTestId(/^curriculum-entry-/);
    await expect(catalogAEntries.nth(0)).toHaveAttribute(
      'data-testid',
      'curriculum-entry-pilot-linear-slope',
    );
    await expect(catalogAEntries.nth(1)).toHaveAttribute(
      'data-testid',
      'curriculum-entry-pilot-quadratic-vertex',
    );
    const catalogBEntries = page
      .getByTestId('curriculum-catalog-pilot-edition-b')
      .getByTestId(/^curriculum-entry-/);
    await expect(catalogBEntries.nth(0)).toHaveAttribute(
      'data-testid',
      'curriculum-entry-pilot-vertex-first',
    );
    await expect(catalogBEntries.nth(1)).toHaveAttribute(
      'data-testid',
      'curriculum-entry-pilot-slope-after',
    );
    await expect(page.getByTestId('curriculum-book-pilot-book-b1')).toContainText('Sample book B1');
    await expect(page.getByTestId('curriculum-book-pilot-book-b2')).toContainText('Sample book B2');
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

  test('opens the same tool from the second catalog with its own preset and snapshot', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one sequential flow, desktop');

    await page.goto('/curriculum/pilot-slope-after?lang=en');
    await expect(page.getByTestId('placement-breadcrumb')).toContainText('Sample book B2');
    await expect(page.getByTestId('placement-source')).toHaveText(
      /not a verified textbook chapter/i,
    );
    // The preset belongs to this catalog entry, not to the tool and not to catalog A.
    await expect(page.getByTestId('formula')).toHaveText('y = −x + 2');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/chapter preset/i);
    const before = await page.request.get('/api/me/placement-state/math.functions.pilot-slope-after');
    expect(before.status()).toBe(404);
    const catalogABefore = await page.request.get(
      '/api/me/placement-state/math.functions.pilot-linear-slope',
    );
    const catalogABeforeStatus = catalogABefore.status();
    const catalogABeforeText = catalogABeforeStatus === 200 ? await catalogABefore.text() : null;

    await page.locator('#coef-a').fill('-4');
    await expect(page.getByTestId('formula')).toHaveText('y = −4x + 2');
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);

    const stored = await page.request.get('/api/me/placement-state/math.functions.pilot-slope-after');
    expect(stored.status()).toBe(200);
    expect(Number(((await stored.json()) as { values: { a: number } }).values.a)).toBeCloseTo(-4, 6);

    // Catalog A's slope entry is a different scope: its stored snapshot is byte-identical
    // before and after the write above (whether or not an earlier test created one).
    const catalogAAfter = await page.request.get(
      '/api/me/placement-state/math.functions.pilot-linear-slope',
    );
    expect(catalogAAfter.status()).toBe(catalogABeforeStatus);
    expect(catalogAAfter.status() === 200 ? await catalogAAfter.text() : null).toBe(
      catalogABeforeText,
    );

    // Re-entering the second catalog's entry applies its own snapshot.
    await page.reload();
    await expect(page.getByTestId('formula')).toHaveText('y = −4x + 2');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/your saved parameters/i);
    await shot(page, STAGE, 'catalog-b-saved');
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
    await expect(page.getByTestId('curriculum-catalog-pilot-edition-b')).toBeVisible();
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

/**
 * Six-volume PEP directory (ADR-006, R9 approved scope reset) against the real server and the
 * real bundle.
 *
 * The directory is the printed table of contents of five volumes of the 2022 curriculum
 * revision plus the grade-9 volume that prints its own 2011 edition line. Both are peer
 * textbook entries under the subject — no "old/new" badge, zone or route separates them; each
 * one simply keeps its own books, chapter numbering and edition details. Two of the 108
 * sections host the existing function tool; the rest are published empty, because "this
 * section exists and has no tool yet" is the honest state.
 */
const G3_STAGE = 'r9/g3';
const CURRENT = 'pep-math-2022';
const LEGACY = 'pep-math-9b-legacy';
const LINEAR_PLACEMENT = 'math.functions.pep-8b-ch23-s2-linear-graph';
const QUADRATIC_PLACEMENT = 'math.functions.pep-9a-ch26-s2-quadratic-graph';

test.describe('six-volume PEP directory', () => {
  test('lists both textbook editions as peer catalogs, then the pilot catalogs', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one directory walk, desktop');

    await page.goto('/curriculum?lang=en');
    await expect(page.getByTestId('curriculum-list')).toBeVisible();

    const catalogs = page.getByTestId(
      /^curriculum-catalog-(pep-math-2022|pep-math-9b-legacy|pilot-edition|pilot-edition-b)$/,
    );
    await expect(catalogs).toHaveCount(4);
    const order = await catalogs.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    expect(order).toEqual([
      `curriculum-catalog-${CURRENT}`,
      `curriculum-catalog-${LEGACY}`,
      'curriculum-catalog-pilot-edition',
      'curriculum-catalog-pilot-edition-b',
    ]);

    // Five books, in the order of the edition.
    const current = page.getByTestId(`curriculum-catalog-${CURRENT}`);
    const books = current.getByTestId(/^curriculum-book-pep-math-/);
    const bookIds = await books.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    expect(bookIds).toEqual([
      'curriculum-book-pep-math-7a-2024',
      'curriculum-book-pep-math-7b-2025',
      'curriculum-book-pep-math-8a-2025',
      'curriculum-book-pep-math-8b-2026',
      'curriculum-book-pep-math-9a-2026',
    ]);
    // The catalog states its publisher and edition, because this one is a real textbook.
    await expect(current).toContainText(/People's Education Press/);
    await expect(current).toContainText(/2022 curriculum revision/);
    // The edition is ordinary detail, not a badge: no catalog carries an edition badge.
    await expect(page.getByTestId(/^curriculum-catalog-edition-/)).toHaveCount(0);

    // Chapter 23 of grade 8 volume 2: sections in printed order, one of them holding the tool.
    const chapter = page.getByTestId('curriculum-chapter-pep-math-8b-2026-ch23');
    await expect(chapter).toContainText('Chapter 23 Linear functions');
    const sections = chapter.getByTestId(/^curriculum-section-pep-math-8b-2026-ch23-/);
    const sectionIds = await sections.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    expect(sectionIds).toEqual([
      'curriculum-section-pep-math-8b-2026-ch23-s1',
      'curriculum-section-pep-math-8b-2026-ch23-s2',
      'curriculum-section-pep-math-8b-2026-ch23-s3',
      'curriculum-section-pep-math-8b-2026-ch23-s4',
      'curriculum-section-pep-math-8b-2026-ch23-project',
    ]);
    await expect(page.getByTestId('curriculum-section-pep-math-8b-2026-ch23-s1')).toContainText(
      'No tool is published in this section yet.',
    );
    await expect(page.getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')).toContainText(
      '23.2 Graphs and properties of linear functions',
    );
    await expect(page.getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')).toContainText(
      'Page 117',
    );
    await expect(
      page
        .getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')
        .getByTestId('curriculum-entry-pep-8b-23-2-linear-graph'),
    ).toHaveCount(1);

    // The grade-9 edition names its own edition line and keeps its own chapter 26 (inverse
    // proportion), not the 2022 edition's chapter 26 (quadratic functions).
    const legacy = page.getByTestId(`curriculum-catalog-${LEGACY}`);
    await expect(legacy).toContainText(/2011 curriculum edition/);
    await expect(legacy).not.toContainText(/old edition still in use/i);
    await expect(legacy).toContainText('Chapter 26 Inverse proportional functions');
    await expect(current).toContainText('Chapter 26 Quadratic functions');
    await shot(page, G3_STAGE, 'six-volume-directory');
  });

  test('opens 8b 23.2 with its linear preset, saves it, and leaves 9a 26.2 untouched', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one sequential flow, desktop');

    await page.goto('/curriculum/pep-8b-23-2-linear-graph?lang=en');
    await expect(page.getByTestId('placement-breadcrumb')).toContainText(
      '23.2 Graphs and properties of linear functions',
    );
    await expect(page.getByTestId('placement-breadcrumb')).toContainText('Grade 8, volume 2');
    // A verified catalog is not a pilot example any more.
    await expect(page.getByTestId('placement-source')).toHaveText(/chapter mapping reviewed/i);
    await expect(page.getByTestId('formula')).toHaveText('y = 2x + 1');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/chapter preset/i);

    const otherBefore = await page.request.get(`/api/me/placement-state/${QUADRATIC_PLACEMENT}`);
    expect(otherBefore.status()).toBe(404);

    await page.locator('#coef-a').fill('5');
    await expect(page.getByTestId('formula')).toHaveText('y = 5x + 1');
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);

    const stored = await page.request.get(`/api/me/placement-state/${LINEAR_PLACEMENT}`);
    expect(stored.status()).toBe(200);
    const body = (await stored.json()) as {
      placementId: string;
      placementVersion: number;
      values: Record<string, number | string>;
    };
    expect(body.placementId).toBe(LINEAR_PLACEMENT);
    expect(body.placementVersion).toBe(1);
    expect(Number(body.values.a)).toBeCloseTo(5, 6);

    // The sibling section of the same tool is a different scope, still empty.
    const otherAfter = await page.request.get(`/api/me/placement-state/${QUADRATIC_PLACEMENT}`);
    expect(otherAfter.status()).toBe(404);

    await page.reload();
    await expect(page.getByTestId('formula')).toHaveText('y = 5x + 1');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/your saved parameters/i);
    await shot(page, G3_STAGE, 'pep-8b-linear-saved');
  });

  test('opens 9a 26.2 with its own quadratic preset and its own snapshot', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one sequential flow, desktop');

    await page.goto('/curriculum/pep-9a-26-2-quadratic-graph?lang=en');
    await expect(page.getByTestId('placement-breadcrumb')).toContainText(
      '26.2 Graphs and properties of quadratic functions',
    );
    await expect(page.getByTestId('placement-breadcrumb')).toContainText('Grade 9, volume 1');
    await expect(page.getByTestId('formula')).toHaveText('y = x² − 4x + 3');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/chapter preset/i);

    // The linear section's saved parameters from the previous test are not inherited.
    await expect(page.getByTestId('restore-state-button')).toHaveCount(0);
    await expect(page.getByTestId('delete-state-button')).toHaveCount(0);

    await page.locator('#coef-a').fill('2');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x² − 4x + 3');
    await page.getByTestId('save-state-button').click();
    await expect(page.getByTestId('saved-state-notice')).toHaveText(/saved/i);

    const stored = await page.request.get(`/api/me/placement-state/${QUADRATIC_PLACEMENT}`);
    expect(stored.status()).toBe(200);
    const body = (await stored.json()) as { values: Record<string, number | string> };
    expect(Number(body.values.a)).toBeCloseTo(2, 6);
    expect(String(body.values.mode)).toBe('quadratic');

    // The linear snapshot is untouched by this write.
    const linear = await page.request.get(`/api/me/placement-state/${LINEAR_PLACEMENT}`);
    expect(linear.status()).toBe(200);
    expect(Number(((await linear.json()) as { values: { a: number } }).values.a)).toBeCloseTo(5, 6);

    await page.reload();
    await expect(page.getByTestId('formula')).toHaveText('y = 2x² − 4x + 3');
    await shot(page, G3_STAGE, 'pep-9a-quadratic-saved');
  });

  test('still opens the R8 illustrative entries whose ids must not move', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one run, desktop');

    await page.goto('/curriculum/pilot-linear-slope?lang=en');
    await expect(page.getByTestId('placement-breadcrumb')).toContainText(
      'Sample chapter A · slope and intercept',
    );
    await expect(page.getByTestId('parameter-origin')).toHaveText(
      /chapter preset|your saved parameters/i,
    );
    await expect(page.getByTestId('placement-source')).toHaveText(
      /not a verified textbook chapter/i,
    );
  });

  test('reads the six-volume directory on a phone without horizontal scrolling', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone layout only');

    await page.goto('/curriculum?lang=en');
    await expect(page.getByTestId(`curriculum-catalog-${CURRENT}`)).toBeVisible();
    await expect(page.getByTestId('curriculum-chapter-pep-math-8b-2026-ch23')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);

    await page.goto('/curriculum/pep-8b-23-2-linear-graph?lang=en');
    await expect(page.getByTestId('formula')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);
    await shot(page, G3_STAGE, 'pep-8b-linear-mobile');
  });
});
