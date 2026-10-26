import { afterEach, describe, expect, it } from 'vitest';

import { api, cookieHeader, register, startAuthHarness, type AuthHarness } from './support/auth-app.js';
import { SPA_MARKER } from './helpers.js';

/**
 * SPA deep-link gate (design §3.2/§2, R-05).
 *
 * A browser navigation to a protected page is answered with a 302 to the login page
 * carrying the original target in `next`. Only the documented public pages are served
 * to anonymous visitors; build artefacts stay public (they are static files), and the
 * API is never answered with an HTML redirect.
 */

const HTML = { accept: 'text/html,application/xhtml+xml' };

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function start(): Promise<AuthHarness> {
  harness = await startAuthHarness();
  return harness;
}

function location(response: { headers: Record<string, unknown> }): string {
  return String(response.headers['location'] ?? '');
}

describe('anonymous navigations are redirected to the login page', () => {
  it('redirects the catalog root and keeps the target in next', async () => {
    const server = await start();

    const response = await api(server.app, { method: 'GET', url: '/', headers: HTML });

    expect(response.status).toBe(302);
    expect(location(response)).toBe('/login?next=%2F');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.setCookie).toEqual([]);
  });

  it('redirects an experiment deep link with its query string', async () => {
    const server = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: '/experiments/math-functions?lang=zh-CN',
      headers: HTML,
    });

    expect(response.status).toBe(302);
    expect(location(response)).toBe(
      '/login?next=%2Fexperiments%2Fmath-functions%3Flang%3Dzh-CN',
    );
    expect(response.text).not.toContain(SPA_MARKER);
  });

  it('redirects an unknown page instead of leaking the shell', async () => {
    const server = await start();

    const response = await api(server.app, { method: 'GET', url: '/nope', headers: HTML });

    expect(response.status).toBe(302);
    expect(location(response)).toBe('/login?next=%2Fnope');
  });

  it('redirects HEAD as well', async () => {
    const server = await start();

    const response = await server.app.inject({
      method: 'HEAD',
      url: '/',
      headers: HTML,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?next=%2F');
  });

  it('does not redirect API calls that happen to accept HTML', async () => {
    const server = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/catalog',
      headers: HTML,
    });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(location(response)).toBe('');
  });
});

describe('public pages stay public', () => {
  for (const url of ['/login', '/register', '/login?next=%2F%2Fevil.example', '/about']) {
    it(`serves ${url} to anonymous visitors without redirecting`, async () => {
      const server = await start();

      const response = await api(server.app, { method: 'GET', url, headers: HTML });

      expect(response.status).toBe(200);
      expect(response.text).toContain(SPA_MARKER);
      expect(location(response)).toBe('');
    });
  }

  it('serves build artefacts without a session', async () => {
    const server = await start();

    const response = await api(server.app, { method: 'GET', url: '/assets/app.js' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('oel-app');
  });
});

describe('authenticated navigations reach the app shell', () => {
  it('serves the catalog root and the experiment deep link', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    const headers = { ...HTML, ...cookieHeader(created.cookie()) };

    for (const url of ['/', '/experiments/math-functions?lang=zh-CN']) {
      const response = await api(server.app, { method: 'GET', url, headers });
      expect(response.status).toBe(200);
      expect(response.text).toContain(SPA_MARKER);
    }
  });

  it('redirects again once the session is revoked', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    const headers = { ...HTML, ...cookieHeader(created.cookie()) };

    await api(server.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers,
      payload: {},
    });

    const response = await api(server.app, { method: 'GET', url: '/', headers });
    expect(response.status).toBe(302);
  });
});

describe('non-navigation requests are not redirected', () => {
  it('leaves a POST for a protected page as a 404, not a redirect', async () => {
    const server = await start();

    const response = await api(server.app, {
      method: 'POST',
      url: '/experiments/math-functions',
      headers: HTML,
      payload: {},
    });

    expect(response.status).not.toBe(302);
  });

  it('does not redirect a JSON fetch of the app root', async () => {
    const server = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: '/',
      headers: { accept: 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(location(response)).toBe('');
  });
});
