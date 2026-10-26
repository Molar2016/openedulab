import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** Shared helpers for the authenticated E2E specs. */

export const TEACHER = {
  identifier: 'e2e-teacher@example.com',
  password: 'classroom demo password',
} as const;

/** A second ordinary account, used to prove that isolation is real. */
export const SECOND_TEACHER = {
  identifier: 'e2e-second-teacher@example.com',
  password: 'second classroom password',
} as const;

export const SECOND_STATE = 'test-results/e2e/.auth/second.json';

export function evidenceDir(stage: string): string {
  return join(process.cwd(), 'docs', 'evidence', stage);
}

export async function shot(page: Page, stage: string, name: string): Promise<void> {
  const dir = evidenceDir(stage);
  await mkdir(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
}

/** Signs in through the visible form — the same path a teacher takes. */
export async function signIn(
  page: Page,
  credentials: { identifier: string; password: string },
): Promise<void> {
  await page.getByTestId('auth-identifier').fill(credentials.identifier);
  await page.getByTestId('auth-password').fill(credentials.password);
  await page.getByTestId('auth-submit').click();
}

export async function openExperiment(page: Page, locale: 'en' | 'zh-CN' = 'en'): Promise<void> {
  await page.goto(`/?lang=${locale}`);
  await page
    .getByTestId('experiment-card-math-functions')
    .getByRole('link', { name: /start experiment|开始实验/i })
    .click();
  await page.getByTestId('formula').waitFor();
}
