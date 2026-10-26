import { expect, test } from '@playwright/test';
import { openExperiment, TEACHER, shot } from './support';

/**
 * Diagnostics, end to end (B5, R-14/R-16/R-20/R-22).
 *
 * The browser produces real events by using the experiment; then the *operator channel*
 * is asked the questions the product asks. Nothing here reads a mock: the rows come from
 * the same SQLite database the API wrote over the wire.
 *
 * The token below is the local-only value that `scripts/e2e-server.mjs` passes in; it
 * guards an ephemeral process on 127.0.0.1 and is not a deployment secret.
 */
const OPERATOR_TOKEN = 'e2e-local-operator-token-not-a-secret';
const REASON = 'e2e verification of the diagnostics pipeline';
const STAGE = 'b6';

function operator(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${OPERATOR_TOKEN}`,
    'x-operator-label': 'e2e-runner',
    ...extra,
  };
}

function windowQuery(): string {
  const now = Date.now();
  return `from=${String(now - 6 * 60 * 60 * 1000)}&to=${String(now + 60 * 60 * 1000)}`;
}

test.describe('operator channel', () => {
  test('answers the product questions from events this browser produced', async ({ page }) => {
    test.skip(
      test.info().project.name !== 'desktop-chromium',
      'one full HTTP round trip is enough; the mobile project repeats the UI behaviour',
    );

    await openExperiment(page);
    await page.locator('#coef-a').fill('2');
    await expect(page.getByTestId('formula')).toHaveText('y = 2x²');
    await page.getByTestId('reset-button').click();

    // Give the batched adapter time to flush (400 ms delay in the app).
    await page.waitForTimeout(1_500);

    const overview = await page.request.get(`/api/internal/overview?${windowQuery()}`, {
      headers: operator(),
    });
    expect(overview.status()).toBe(200);
    const body = (await overview.json()) as {
      dataGaps: unknown[];
      experiments: {
        experimentId: string;
        openAccounts: number;
        openVisits: number;
        interactedVisits: number;
        resets: number;
      }[];
    };
    expect(body.dataGaps).toEqual([]);
    const entry = body.experiments.find((item) => item.experimentId === 'math.functions');
    expect(entry, 'the experiment must have been opened and seen by the operator channel').toBeTruthy();
    expect(entry?.openAccounts).toBeGreaterThanOrEqual(1);
    expect(entry?.openVisits).toBeGreaterThanOrEqual(1);
    expect(entry?.interactedVisits).toBeGreaterThanOrEqual(1);
    expect(entry?.resets).toBeGreaterThanOrEqual(1);

    const funnel = await page.request.get(
      `/api/internal/experiments/math.functions/funnel?${windowQuery()}`,
      { headers: operator() },
    );
    expect(funnel.status()).toBe(200);
    const funnelBody = (await funnel.json()) as {
      counts: Record<string, number>;
      controls: { controlGroup: string }[];
    };
    expect(funnelBody.counts.experiment_open).toBeGreaterThanOrEqual(1);
    expect(funnelBody.counts.experiment_first_interaction).toBeGreaterThanOrEqual(1);
    // The coefficient slider is control category "a"; no value is stored anywhere.
    expect(funnelBody.controls.map((control) => control.controlGroup)).toContain('a');
    expect(JSON.stringify(funnelBody)).not.toMatch(/coef|0\.1|slider/i);

    const exportResponse = await page.request.get(
      `/api/internal/export/events.csv?${windowQuery()}&reason=${encodeURIComponent(REASON)}`,
      { headers: operator() },
    );
    expect(exportResponse.status()).toBe(200);
    const csv = await exportResponse.text();
    expect(csv.split('\n')[0]).toContain('occurred_at_min,experiment_id,content_version');
    expect(csv).not.toContain('received_at');
    // The browser's user agent must never be part of the export.
    expect(csv).not.toContain('HeadlessChrome');
    expect(csv).not.toContain('Mozilla');

    await shot(page, STAGE, 'operator-console-output');
  });

  test('is invisible to the signed-in teacher and to anonymous visitors', async ({ page, browser }) => {
    const withSession = await page.request.get(`/api/internal/overview?${windowQuery()}`);
    expect(withSession.status()).toBe(404);

    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonymousPage = await anonymous.newPage();
    const asVisitor = await anonymousPage.request.get(`/api/internal/overview?${windowQuery()}`);
    expect(asVisitor.status()).toBe(404);
    await anonymous.close();
  });

  test('records who exported what, and why', async ({ page }) => {
    test.skip(
      test.info().project.name !== 'desktop-chromium',
      'audit is asserted once per run',
    );

    const exportResponse = await page.request.get(
      `/api/internal/export/feedback.csv?${windowQuery()}&reason=${encodeURIComponent(REASON)}`,
      { headers: operator() },
    );
    expect(exportResponse.status()).toBe(200);

    const withoutReason = await page.request.get(
      `/api/internal/export/feedback.csv?${windowQuery()}`,
      { headers: operator() },
    );
    expect(withoutReason.status()).toBe(400);

    const withoutLabel = await page.request.get(
      `/api/internal/export/feedback.csv?${windowQuery()}&reason=${encodeURIComponent(REASON)}`,
      { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } },
    );
    // The label is required for audited reads; a missing one is a validation error.
    expect(withoutLabel.status()).toBe(400);
  });
});

test.describe('feedback reaches the operator export', () => {
  test('submits a report in the browser and finds it in the CSV', async ({ page }) => {
    test.skip(
      test.info().project.name !== 'desktop-chromium',
      'one submission is enough for this run',
    );

    await openExperiment(page);
    await page.getByTestId('feedback-button').click();
    const message = 'E2E report: the axis label is hard to read on a projector';
    await page.getByRole('textbox').fill(message);
    await page.getByRole('button', { name: 'Preview of what would be sent' }).click();
    await page.getByTestId('feedback-send').click();
    await expect(page.getByTestId('feedback-sent')).toBeVisible();

    const exportResponse = await page.request.get(
      `/api/internal/export/feedback.csv?${windowQuery()}&reason=${encodeURIComponent(REASON)}`,
      { headers: operator() },
    );
    expect(exportResponse.status()).toBe(200);
    const csv = await exportResponse.text();

    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'id,created_at,experiment_id,content_version,app_version,category,message,account_id',
    );
    const submitted = lines.slice(1).find((line) => line.includes('axis label is hard to read'));
    expect(submitted, 'the report written in the browser must be in the export').toBeTruthy();
    // The account column is an internal id, never the login identifier.
    expect(submitted).not.toContain(TEACHER.identifier);
  });
});
