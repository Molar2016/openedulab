import { expect, test, type Page } from '@playwright/test';
import { openExperiment, shot } from './support';

/**
 * Authenticated product surface (B3).
 *
 * Formerly `m1.spec.ts`, the no-login prototype spec. Every assertion that described the
 * prototype ("the catalog is public", "the debug hook exposes the analytics sink") is
 * replaced by its authenticated counterpart: the catalog only exists after a real session,
 * and the production bundle ships no debug sink — so event whitelisting is asserted where
 * it can be observed, in the API tests and (B5) through the operator query.
 */

const STAGE = 'b3';

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

test.describe('catalog and search (signed in)', () => {
  test('shows the account, finds the experiment by search and filter, and counts results', async ({
    page,
  }) => {
    await page.goto('/?lang=en');

    await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();
    await expect(page.getByTestId('account-block')).toContainText('e***@example.com');
    await expect(page.getByTestId('result-count')).toHaveText('1 experiment');
    await expect(page.getByTestId('experiment-card-math-functions')).toBeVisible();

    await page.getByLabel('Search experiments').fill('chem');
    await expect(page.getByTestId('result-count')).toHaveText('0 experiments');
    await expect(page.getByTestId('catalog-empty')).toBeVisible();

    await page.getByLabel('Search experiments').fill('quadratic');
    await expect(page.getByTestId('result-count')).toHaveText('1 experiment');

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByTestId('result-count')).toHaveText('1 experiment');
    await shot(page, STAGE, 'catalog-en');
  });

  test('switches to Chinese and keeps the URL shareable', async ({ page }) => {
    await page.goto('/?lang=en');
    await page.getByRole('button', { name: '中文' }).click();

    await expect(page.getByRole('heading', { name: '选择一个实验' })).toBeVisible();
    await expect(page).toHaveURL(/lang=zh-CN/);
    await expect(page.getByTestId('result-count')).toHaveText('共 1 个实验');
    await expect(page.getByTestId('experiment-card-math-functions')).toContainText(
      '一次函数与二次函数',
    );
    await shot(page, STAGE, 'catalog-zh');
  });
});

test.describe('experiment', () => {
  test('loads server metadata, changes coefficients, resets and switches mode', async ({ page }) => {
    await page.goto('/?lang=en');
    await page
      .getByTestId('experiment-card-math-functions')
      .getByRole('link', { name: /start experiment/i })
      .click();

    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page.getByTestId('experiment-meta')).toContainText('1.0.0');
    await expect(page.getByTestId('account-block')).toBeVisible();
    await shot(page, STAGE, 'experiment-default');

    await page.locator('#coef-a').fill('2');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x²');
    await expect(page.getByTestId('readout-vertex')).toContainText('(0, 0)');

    await page.locator('#coef-b').fill('-2');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x² − 2x');
    await expect(page.getByTestId('readout-roots')).toContainText('0, 1');
    await expect(page.getByTestId('readout-vertex')).toContainText('(0.5, -0.5)');
    await shot(page, STAGE, 'experiment-adjusted');

    await page.getByTestId('reset-button').click();
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page.locator('#coef-a')).toHaveValue('1');

    await page.getByRole('button', { name: 'Linear y = ax + b' }).click();
    await expect(page.getByTestId('readout-slope')).toBeVisible();
    await expect(page.getByTestId('formula')).toHaveText('y = x');
    await expect(page.locator('#coef-c')).toBeDisabled();
  });

  test('shows the degenerate-quadratic warning for a = 0', async ({ page }) => {
    await openExperiment(page);

    await page.locator('#coef-a').fill('0');

    await expect(page.getByTestId('formula')).toHaveText('y = 0');
    await expect(page.getByTestId('model-warnings')).toContainText('no longer quadratic');
  });

  test('previews feedback, sends it on request and confirms a stored report', async ({ page }) => {
    await openExperiment(page);
    await page.getByTestId('feedback-button').click();
    await expect(page.getByTestId('feedback-dialog')).toBeVisible();

    const message = 'The vertex label overlaps the axis';
    await page.getByRole('textbox').fill(message);
    await page.getByRole('button', { name: 'Preview of what would be sent' }).click();

    const preview = page.getByTestId('feedback-preview');
    await expect(preview).toContainText(`"messageLength": ${message.length}`);
    // The preview shows the shape of the payload, not the text the person typed.
    await expect(preview).not.toContainText('vertex label overlaps');
    await shot(page, STAGE, 'feedback-preview');

    await page.getByTestId('feedback-send').click();
    await expect(page.getByTestId('feedback-sent')).toBeVisible();
    await expect(page.getByTestId('feedback-error')).toHaveCount(0);
  });

  test('keeps working when the diagnostics endpoint is down', async ({ page }) => {
    // Simulate "analytics is off / ingest is broken": every event batch fails.
    await page.route('**/api/events', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"server_error"}}' }),
    );

    await openExperiment(page);
    await page.locator('#coef-a').fill('2');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x²');

    // Favorites and recent use are a different data product and must be unaffected.
    const favorite = page.getByTestId('favorite-button');
    if ((await favorite.textContent()) === 'Add to favorites') {
      await favorite.click();
    }
    await expect(favorite).toHaveText('Remove from favorites');

    await page.goto('/me?lang=en');
    await expect(page.getByTestId('recent-list')).toBeVisible();
    await expect(page.getByTestId('recent-list').getByTestId('item-math-functions')).toHaveCount(1);

    // No error was pushed into the experiment UI by the failing diagnostics.
    await expect(page.getByTestId('experiment-error')).toHaveCount(0);
  });

  test('makes no cross-origin request and ships no debug sink', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1:3220') && !url.startsWith('data:')) external.push(url);
    });

    await openExperiment(page);
    await page.locator('#coef-a').fill('3');
    await page.getByTestId('reset-button').click();

    // The production bundle must not expose the local analytics sink.
    expect(await page.evaluate(() => 'openedulab' in window)).toBe(false);
    expect(external).toEqual([]);
  });

  test('enters and exits full screen with consistent state', async ({ page }) => {
    await openExperiment(page);
    const supported = await page.evaluate(() => document.fullscreenEnabled);
    test.skip(!supported, 'Fullscreen API is disabled in this browser context');

    await page.getByTestId('fullscreen-button').click();
    await expect(page.getByTestId('fullscreen-button')).toHaveText('Exit full screen');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await shot(page, STAGE, 'fullscreen');

    await page.getByTestId('fullscreen-button').click();
    await expect(page.getByTestId('fullscreen-button')).toHaveText('Full screen');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  });
});

test.describe('favorites and recent use (B4)', () => {
  test('favorites from the experiment page, sees it in My library, then removes it', async ({ page }) => {
    await openExperiment(page);

    const favorite = page.getByTestId('favorite-button');
    await expect(favorite).toBeVisible();
    // Leave the account in a known state regardless of an earlier failed run.
    if ((await favorite.textContent()) === 'Remove from favorites') {
      await favorite.click();
      await expect(favorite).toHaveText('Add to favorites');
    }

    await favorite.click();
    await expect(favorite).toHaveText('Remove from favorites');
    await expect(favorite).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('link', { name: 'My library' }).click();
    const favorites = page.getByTestId('favorites-list');
    await expect(favorites.getByTestId('item-math-functions')).toBeVisible();
    await shot(page, STAGE, 'me-favorites');

    await page.getByTestId('remove-math.functions').click();
    await expect(page.getByTestId('favorites-empty')).toBeVisible();

    // The experiment page now offers to add it again, i.e. the removal was real.
    await page.getByRole('link', { name: 'Experiment catalog' }).click();
    await page
      .getByTestId('experiment-card-math-functions')
      .getByRole('link', { name: /start experiment/i })
      .click();
    await expect(page.getByTestId('favorite-button')).toHaveText('Add to favorites');
  });

  test('keeps one recent entry per resource and never shows parameter values', async ({ page }) => {
    await openExperiment(page);
    await page.goto('/?lang=en');
    await page
      .getByTestId('experiment-card-math-functions')
      .getByRole('link', { name: /start experiment/i })
      .click();
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    // Change a coefficient: that must not create a second entry nor be stored.
    await page.locator('#coef-a').fill('3');

    await page.goto('/me?lang=en');
    const recent = page.getByTestId('recent-list');
    await expect(recent).toBeVisible();
    await expect(recent.getByTestId('item-math-functions')).toHaveCount(1);
    await expect(recent.locator('li')).toHaveCount(1);
    await expect(page.locator('#me-recent-heading')).toContainText('Recently opened');
    await expect(page.getByTestId('opened-math.functions')).toBeVisible();
    await shot(page, STAGE, 'me-recent');

    // Nothing on this page may show a slider value or a parameter name.
    const text = (await page.getByTestId('recent-list').textContent()) ?? '';
    expect(text).not.toMatch(/coef|slider|param/i);
  });
});

test.describe('accessibility basics', () => {
  test('every interactive control has an accessible name and a label', async ({ page }) => {
    await openExperiment(page);

    const problems = await page.evaluate(() => {
      const issues: string[] = [];
      document.querySelectorAll('button, a').forEach((element) => {
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
        if (!name) issues.push(`unnamed ${element.tagName}:${element.className}`);
      });
      document.querySelectorAll('input, select, textarea').forEach((element) => {
        const id = element.getAttribute('id');
        const wrapped = element.closest('label');
        const labelled = id ? document.querySelector(`label[for="${id}"]`) : null;
        if (!wrapped && !labelled) issues.push(`unlabelled ${element.tagName}#${id}`);
      });
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      if (duplicates.length) issues.push(`duplicate ids: ${duplicates.join(', ')}`);
      return issues;
    });

    expect(problems).toEqual([]);
  });
});

test.describe('mobile layout', () => {
  test('catalog and experiment fit a phone without horizontal scrolling', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'mobile project only');

    await page.goto('/?lang=zh-CN');
    await expect(page.getByRole('heading', { name: '选择一个实验' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await shot(page, STAGE, 'mobile-catalog-zh');

    await page
      .getByTestId('experiment-card-math-functions')
      .getByRole('link', { name: /开始实验/ })
      .click();
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    expect(await noHorizontalOverflow(page)).toBe(true);

    await page.locator('#coef-a').fill('-1');
    await expect(page.getByTestId('formula')).toHaveText('y = −x²');
    await shot(page, STAGE, 'mobile-experiment-zh');
  });
});

test.describe('recording', () => {
  test('short classroom walkthrough (signed in)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop recording only');

    await page.goto('/?lang=zh-CN');
    await expect(page.getByTestId('result-count')).toHaveText('共 1 个实验');
    await page.waitForTimeout(700);

    await page
      .getByTestId('experiment-card-math-functions')
      .getByRole('link', { name: /开始实验/ })
      .click();
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await page.waitForTimeout(600);

    for (const value of ['1.5', '2', '-1']) {
      await page.locator('#coef-a').fill(value);
      await page.waitForTimeout(500);
    }
    await page.locator('#coef-b').fill('-2');
    await page.waitForTimeout(700);
    await page.getByTestId('reset-button').click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '一次函数 y = ax + b' }).click();
    await page.waitForTimeout(900);

    // Keep the walkthrough as evidence (Playwright deletes test-results artefacts later).
    const video = page.video();
    await page.close();
    if (video) {
      await video.saveAs(`${process.cwd()}/docs/evidence/${STAGE}/walkthrough.webm`);
    }
  });
});
