import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// `window.__openedulab` is typed once for the whole project in
// apps/web/src/debug-hook.d.ts; do not re-declare it here.

const EVIDENCE = join(process.cwd(), 'docs', 'evidence', 'm1');

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: false });
}

async function openExperiment(page: Page, locale: 'en' | 'zh-CN' = 'en'): Promise<void> {
  await page.goto(`/?lang=${locale}`);
  await page.getByTestId('experiment-card-math-functions').getByRole('link', { name: /start experiment|开始实验/i }).click();
  await expect(page.getByTestId('formula')).toHaveText('y = x²');
}

test.describe('catalog and search', () => {
  test('finds the experiment by search and filters, with visible result count', async ({ page }) => {
    await page.goto('/?lang=en');
    await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();
    await expect(page.getByTestId('result-count')).toHaveText('1 experiment');
    await expect(page.getByTestId('experiment-card-math-functions')).toBeVisible();

    await page.getByLabel('Search experiments').fill('chem');
    await expect(page.getByTestId('result-count')).toHaveText('0 experiments');
    await expect(page.getByTestId('catalog-empty')).toBeVisible();

    await page.getByLabel('Search experiments').fill('quadratic');
    await expect(page.getByTestId('result-count')).toHaveText('1 experiment');

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByTestId('result-count')).toHaveText('1 experiment');
    await shot(page, 'catalog-en');
  });

  test('switches to Chinese and keeps the URL shareable', async ({ page }) => {
    await page.goto('/?lang=en');
    await page.getByRole('button', { name: '中文' }).click();

    await expect(page.getByRole('heading', { name: '选择一个实验' })).toBeVisible();
    await expect(page).toHaveURL(/lang=zh-CN/);
    await expect(page.getByTestId('result-count')).toHaveText('共 1 个实验');
    await expect(page.getByTestId('experiment-card-math-functions')).toContainText('一次函数与二次函数');
    await shot(page, 'catalog-zh');
  });
});

test.describe('experiment', () => {
  test('changes coefficients, resets and shows model readouts', async ({ page }) => {
    await openExperiment(page);
    await shot(page, 'experiment-default');

    await page.locator('#coef-a').fill('2');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x²');
    await expect(page.getByTestId('readout-vertex')).toContainText('(0, 0)');

    await page.locator('#coef-b').fill('-2');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x² − 2x');
    await expect(page.getByTestId('readout-roots')).toContainText('0, 1');
    await expect(page.getByTestId('readout-vertex')).toContainText('(0.5, -0.5)');
    await shot(page, 'experiment-adjusted');

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

  test('previews feedback and never claims it was sent', async ({ page }) => {
    await openExperiment(page);
    await page.getByTestId('feedback-button').click();
    await expect(page.getByTestId('feedback-dialog')).toBeVisible();

    const message = 'The vertex label overlaps the axis';
    await page.getByRole('textbox').fill(message);
    await page.getByRole('button', { name: 'Preview of what would be sent' }).click();

    const preview = page.getByTestId('feedback-preview');
    await expect(preview).toContainText(`"messageLength": ${message.length}`);
    await expect(preview).toContainText('Not sent');
    await expect(preview).not.toContainText('vertex label overlaps');
    await shot(page, 'feedback-preview');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('feedback-dialog')).toBeHidden();
  });

  test('tracks only whitelisted local events and makes no external requests', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1:5199') && !url.startsWith('data:')) external.push(url);
    });

    await openExperiment(page);
    await page.locator('#coef-a').fill('3');
    await page.getByTestId('reset-button').click();
    await page.getByTestId('complete-button').click();
    await expect(page.getByTestId('complete-note')).toBeVisible();

    const events = await page.evaluate(() => window.__openedulab?.services.debug.analyticsSink.events ?? []);
    const types = events.map((event) => event.type);
    expect(types).toContain('experiment_open');
    expect(types).toContain('experiment_interact');
    expect(types).toContain('experiment_reset');
    expect(types).toContain('experiment_complete');
    for (const event of events) {
      expect(Object.keys(event).every((key) =>
        ['type', 'experimentId', 'moduleVersion', 'locale', 'controlGroup', 'interactionBucket', 'enterOrExit', 'errorCode', 'appVersion'].includes(key),
      )).toBe(true);
    }
    expect(JSON.stringify(events)).not.toMatch(/3(\D|$)/);
    expect(external).toEqual([]);
  });

  test('enters and exits full screen with consistent state', async ({ page }) => {
    await openExperiment(page);
    const supported = await page.evaluate(() => document.fullscreenEnabled);
    test.skip(!supported, 'Fullscreen API is disabled in this browser context');

    await page.getByTestId('fullscreen-button').click();
    await expect(page.getByTestId('fullscreen-button')).toHaveText('Exit full screen');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await shot(page, 'fullscreen');

    await page.getByTestId('fullscreen-button').click();
    await expect(page.getByTestId('fullscreen-button')).toHaveText('Full screen');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(page, 'mobile-catalog-zh');

    await page.getByTestId('experiment-card-math-functions').getByRole('link', { name: /开始实验/ }).click();
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.locator('#coef-a').fill('-1');
    await expect(page.getByTestId('formula')).toHaveText('y = −x²');
    await shot(page, 'mobile-experiment-zh');
  });
});

test.describe('demo recording', () => {
  test('short classroom walkthrough', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop recording only');

    await page.goto('/?lang=zh-CN');
    await expect(page.getByTestId('result-count')).toHaveText('共 1 个实验');
    await page.waitForTimeout(700);

    await page.getByTestId('experiment-card-math-functions').getByRole('link', { name: /开始实验/ }).click();
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
  });
});
