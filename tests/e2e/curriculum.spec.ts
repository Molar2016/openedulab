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
  test('walks the teacher path: search 人教 八下, open the volume, expand 23.2, open its tool', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one full flow, desktop');

    await page.goto('/curriculum?lang=zh-CN');

    await expect(page.getByRole('heading', { level: 1, name: '按教材找工具' })).toBeVisible();
    // One card per volume: there is no edition-catalog level between the course and the book.
    const cards = page.getByTestId(/^curriculum-book-card-/);
    await expect(cards).toHaveCount(6);
    await expect(page.getByTestId('curriculum-catalog-pep-math-2022')).toHaveCount(0);

    // The shorthand teachers type finds exactly the volume in their hand.
    await page.getByRole('searchbox', { name: '搜索教材' }).fill('人教 八下');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('八年级下册');
    await expect(page).toHaveURL(/q=/);
    await shot(page, STAGE, 'a-search-8b');

    await cards.first().click();
    await expect(page).toHaveURL(/book=pep-math-8b-2026/);
    const chapters = page.getByTestId('curriculum-chapters');
    await expect(chapters).toContainText('第二十三章 一次函数');
    // Only this volume's chapters: the other edition's chapter 26 is not here.
    await expect(chapters).not.toContainText('第二十六章');

    // Collapsed by default: expanding a chapter is the only way to its sections.
    const panel = page.getByTestId('curriculum-chapter-panel-pep-math-8b-2026-ch23');
    await expect(panel).toBeHidden();
    await page.getByTestId('curriculum-chapter-toggle-pep-math-8b-2026-ch23').click();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')).toContainText(
      '23.2 一次函数的图象和性质',
    );
    await expect(page).toHaveURL(/chapter=pep-math-8b-2026-ch23/);
    await shot(page, STAGE, 'a-chapter-expanded');

    // A reload restores the volume and the open chapter from the URL alone.
    await page.reload();
    await expect(page.getByTestId('curriculum-chapter-panel-pep-math-8b-2026-ch23')).toBeVisible();

    // The tool keeps its own placement URL: same preset, same breadcrumb, same snapshot scope.
    await page
      .getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')
      .getByRole('link', { name: /一次函数的图象和性质/ })
      .click();
    await expect(page).toHaveURL(new RegExp('/curriculum/pep-8b-23-2-linear-graph'));
    await expect(page.getByTestId('placement-breadcrumb')).toContainText('八年级下册');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x + 1');
    await expect(page.getByTestId('parameter-origin')).toHaveText(/本章预置值|chapter preset/i);
    await expect(page.getByTestId('back-button')).toHaveText(/返回教材目录|back to curriculum/i);
    await shot(page, STAGE, 'a-tool-from-chapter');
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

    // The pilot chapter B is untouched by any of this; chapter-level snapshots are per entry.
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

  test('reads well on a phone: the volume cards and an expanded chapter fit', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone layout only');

    await page.goto('/curriculum?lang=zh-CN');
    await expect(page.getByTestId('curriculum-books')).toBeVisible();
    await expect(page.getByTestId('curriculum-book-card-pep-math-8b-2026')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);

    await page.getByTestId('curriculum-book-card-pep-math-8b-2026').getByRole('link').click();
    await page.getByTestId('curriculum-chapter-toggle-pep-math-8b-2026-ch23').click();
    await expect(page.getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);
    await shot(page, STAGE, 'a-book-mobile');

    await page
      .getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')
      .getByRole('link', { name: /一次函数的图象和性质/ })
      .click();
    await expect(page.getByTestId('formula')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);
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
const LINEAR_PLACEMENT = 'math.functions.pep-8b-ch23-s2-linear-graph';
const QUADRATIC_PLACEMENT = 'math.functions.pep-9a-ch26-s2-quadratic-graph';

test.describe('six-volume PEP directory', () => {
  test('lists the six volumes as one stage of cards, hiding the examples', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'one directory walk, desktop');

    await page.goto('/curriculum?lang=en');
    await expect(page.getByTestId('curriculum-books')).toBeVisible();

    const cards = page.getByTestId(/^curriculum-book-card-/);
    await expect(cards).toHaveCount(6);
    const ids = await cards.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    expect(ids).toEqual([
      'curriculum-book-card-pep-math-7a-2024',
      'curriculum-book-card-pep-math-7b-2025',
      'curriculum-book-card-pep-math-8a-2025',
      'curriculum-book-card-pep-math-8b-2026',
      'curriculum-book-card-pep-math-9a-2026',
      'curriculum-book-card-pep-math-9b-legacy',
    ]);

    // Each card is a real volume with its publisher and its own edition line; the 2011 volume
    // is a peer among them, not a zone and not a second book of the 2022 edition.
    await expect(page.getByTestId('curriculum-book-card-pep-math-8b-2026')).toContainText(
      /People's Education Press/,
    );
    await expect(page.getByTestId('curriculum-book-card-pep-math-8b-2026')).toContainText(
      /2022 curriculum revision/,
    );
    await expect(page.getByTestId('curriculum-book-card-pep-math-9b-legacy')).toContainText(
      /2011 curriculum edition/,
    );
    await expect(page.getByTestId(/^curriculum-catalog-/)).toHaveCount(0);
    // The R8 examples are not textbooks: they are absent here, and their direct URLs below
    // still open. Nothing was deleted from the content.
    await expect(page.getByTestId(/^curriculum-book-card-pilot-/)).toHaveCount(0);
    await shot(page, G3_STAGE, 'a-six-volume-cards');
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

  test('reads one six-volume book on a phone without horizontal scrolling', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone layout only');

    await page.goto('/curriculum?lang=en');
    await expect(page.getByTestId('curriculum-books')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);

    await page.goto(
      '/curriculum?lang=en&stage=middle&subject=math&book=pep-math-8b-2026&chapter=pep-math-8b-2026-ch23',
    );
    await expect(page.getByTestId('curriculum-chapter-panel-pep-math-8b-2026-ch23')).toBeVisible();
    await expect(page.getByTestId('curriculum-section-pep-math-8b-2026-ch23-s2')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);

    await page.goto('/curriculum/pep-8b-23-2-linear-graph?lang=en');
    await expect(page.getByTestId('formula')).toBeVisible();
    expect(await overflowOf(page)).toBeLessThanOrEqual(1);
    await shot(page, G3_STAGE, 'pep-8b-linear-mobile');
  });
});
