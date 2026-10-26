import { expect, test } from '@playwright/test';
import { shot, signIn, TEACHER } from './support';

/**
 * The gate, from the outside (B3, R-05).
 *
 * Everything here runs without the shared session: this is a visitor with no cookie. The
 * point is that the *server* refuses — the assertions would still pass if the React guard
 * were deleted, because the 302 and the 401 come from Fastify.
 */
test.use({ storageState: { cookies: [], origins: [] } });

// This spec registers accounts to exercise the real credential paths; the API allows five
// registrations per hour per IP (a limit that is deliberately not relaxed for tests), so
// it runs on two projects instead of all four.
const ALLOWED_PROJECTS = new Set(['desktop-chromium', 'mobile-chromium']);
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(!ALLOWED_PROJECTS.has(testInfo.project.name), 'registration budget: desktop + mobile');
});

const STAGE = 'b6';

test.describe('a visitor without a session', () => {
  test('is redirected from the root to the login page', async ({ page }) => {
    await page.goto('/?lang=en');

    await expect(page).toHaveURL(/\/login\?/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByTestId('experiment-card-math-functions')).toHaveCount(0);
    await shot(page, STAGE, 'gate-login-en');
  });

  test('keeps the deep-link target, rejects a wrong password, then opens the experiment', async ({
    page,
  }) => {
    await page.goto('/experiments/math-functions?lang=en');
    await expect(page).toHaveURL(/\/login\?next=%2Fexperiments%2Fmath-functions/);

    await signIn(page, { identifier: TEACHER.identifier, password: 'definitely not the password' });
    await expect(page.getByTestId('auth-error')).toContainText('Wrong identifier or password.');
    await expect(page).toHaveURL(/\/login/);
    await shot(page, STAGE, 'gate-wrong-password');

    await signIn(page, TEACHER);
    await expect(page.getByTestId('formula')).toHaveText('y = x²');
    await expect(page).toHaveURL(/\/experiments\/math-functions/);
    await shot(page, STAGE, 'gate-deep-link-after-login');
  });

  test('cannot read the API directly, not even with an HTML Accept header', async ({ page }) => {
    const catalog = await page.request.get('/api/catalog', {
      headers: { accept: 'text/html' },
    });
    expect(catalog.status()).toBe(401);
    expect((await catalog.json()).error.code).toBe('unauthenticated');

    const experiment = await page.request.get('/api/experiments/math.functions');
    expect(experiment.status()).toBe(401);

    const forged = await page.request.get('/api/catalog', {
      headers: { cookie: `oel_sid=${'a'.repeat(43)}` },
    });
    expect(forged.status()).toBe(401);
  });

  test('can read the public pages', async ({ page }) => {
    await page.goto('/about?lang=en');
    await expect(page.getByRole('heading', { name: 'About this service' })).toBeVisible();
    await expect(page.getByText('What is stored')).toBeVisible();
  });
});

test.describe('registration and sign-out', () => {
  test('registers, signs out, and the captured cookie cannot be replayed', async ({
    page,
    context,
    playwright,
  }, testInfo) => {
    await page.goto('/register?lang=en');
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
    await shot(page, STAGE, 'gate-register-en');

    // One identifier per browser project: the desktop and mobile runs share a server and
    // therefore a database, so a fixed address would collide as 409 on the second run.
    const identifier = `e2e-second-${testInfo.project.name}@example.com`;

    await page.getByTestId('auth-identifier').fill(identifier);
    await page.getByTestId('auth-password').fill('second classroom password');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();
    await expect(page.getByTestId('account-block')).toContainText('e***@example.com');

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'oel_sid');
    expect(sessionCookie, 'the server must have set an HttpOnly session cookie').toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);

    await page.getByTestId('logout-button').click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // The session was revoked server-side, so a reload still bounces to the login page.
    await page.goto('/?lang=en');
    await expect(page).toHaveURL(/\/login\?/);

    // Replaying the token that the browser used to hold must not work either.
    const replay = await playwright.request.newContext({
      baseURL: 'http://127.0.0.1:3220',
      extraHTTPHeaders: { cookie: `oel_sid=${String(sessionCookie?.value)}` },
    });
    try {
      expect((await replay.get('/api/catalog')).status()).toBe(401);
    } finally {
      await replay.dispose();
    }
  });
});

test.describe('the operator channel', () => {
  test('is invisible to anonymous callers and to ordinary accounts', async ({ page }) => {
    for (const url of [
      '/api/internal/overview',
      '/api/internal/export/events.csv',
      '/api/internal/accounts/anything/timeline',
    ]) {
      const anonymous = await page.request.get(url);
      expect(anonymous.status(), `${url} must not exist for visitors`).toBe(404);
    }

    await page.goto('/login?lang=en');
    await signIn(page, TEACHER);
    await expect(page.getByRole('heading', { name: 'Pick an experiment' })).toBeVisible();

    for (const url of ['/api/internal/overview', '/api/internal/export/events.csv']) {
      const signedIn = await page.request.get(url);
      expect(signedIn.status(), `${url} must be 404 for a normal account too`).toBe(404);
    }
  });
});
