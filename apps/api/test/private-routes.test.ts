import { afterEach, describe, expect, it } from 'vitest';

import { api, errorCode, SESSION_COOKIE, startAuthHarness, type AuthHarness } from './support/auth-app.js';
import {
  isPrivateApiRoute,
  isPublicApiRoute,
  type RouteEntry,
} from '../src/http/route-inventory.js';

/**
 * B3 route inventory (design §3.3, §12 B3 exit: "no route can bypass requireSession").
 *
 * Two halves, both needed:
 * 1. Structural — every route the running server registers under /api/ must be in the
 *    explicit public allowlist (health, credentials) or the session-gated list. A new
 *    endpoint added without declaring it fails this test instead of silently shipping
 *    as "public because nobody looked".
 * 2. Behavioural — every session-gated route denies anonymous and forged callers with
 *    401, and no gated route is a 404 pretending to exist.
 *
 * This file replaces the B1/B2 placeholder test, which asserted those same paths denied
 * *everyone* because authorization did not exist yet. That invariant is necessarily
 * superseded by B3; the replacement is stricter, not looser.
 */

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function start(): Promise<AuthHarness> {
  harness = await startAuthHarness();
  return harness;
}

function apiRoutes(entries: readonly RouteEntry[]): RouteEntry[] {
  return entries.filter((entry) => entry.url === '/api' || entry.url.startsWith('/api/'));
}

/** Turns `/api/me/favorites/:experimentId` into a requestable URL. */
function requestUrl(url: string): string {
  return url.replace(/:[A-Za-z]+/g, 'math.functions');
}

describe('API route inventory', () => {
  it('registers only classified API routes', async () => {
    const server = await start();

    const unclassified = apiRoutes(server.app.routeInventory).filter(
      (entry) => !isPublicApiRoute(entry) && !isPrivateApiRoute(entry),
    );

    expect(unclassified.map((entry) => `${entry.method} ${entry.url}`)).toEqual([]);
  });

  it('exposes the credential routes as public and the resource routes as private', async () => {
    const server = await start();
    const routes = apiRoutes(server.app.routeInventory);

    const publicRoutes = routes
      .filter(isPublicApiRoute)
      .map((entry) => `${entry.method} ${entry.url}`);
    expect(publicRoutes).toContain('POST /api/auth/register');
    expect(publicRoutes).toContain('POST /api/auth/login');
    expect(publicRoutes).toContain('POST /api/auth/logout');
    expect(publicRoutes).toContain('GET /api/auth/session');
    expect(publicRoutes).toContain('GET /api/healthz');

    const privateRoutes = routes
      .filter(isPrivateApiRoute)
      .map((entry) => `${entry.method} ${entry.url}`);
    expect(privateRoutes).toContain('GET /api/catalog');
    expect(privateRoutes).toContain('GET /api/experiments/:experimentId');
    // Not implemented yet (B4/B5): they must not exist as fake endpoints either.
    expect(routes.some((entry) => entry.url.startsWith('/api/me/'))).toBe(false);
    expect(routes.some((entry) => entry.url === '/api/events')).toBe(false);
    expect(routes.some((entry) => entry.url === '/api/feedback')).toBe(false);
  });

  it('denies anonymous and forged callers on every private route', async () => {
    const server = await start();
    const routes = apiRoutes(server.app.routeInventory).filter(isPrivateApiRoute);
    expect(routes.length).toBeGreaterThan(0);

    for (const entry of routes) {
      const method = entry.method as 'GET' | 'POST' | 'PUT' | 'DELETE';
      const anonymous = await api(server.app, { method, url: requestUrl(entry.url) });
      expect(
        anonymous.status,
        `${entry.method} ${entry.url} must deny anonymous callers`,
      ).toBe(401);
      expect(errorCode(anonymous)).toBe('unauthenticated');

      const forged = await api(server.app, {
        method,
        url: requestUrl(entry.url),
        headers: { cookie: `${SESSION_COOKIE}=${'z'.repeat(43)}` },
      });
      expect(forged.status, `${entry.method} ${entry.url} must deny a forged cookie`).toBe(401);
    }
  });

  it('does not expose an operator channel while no operator token is configured', async () => {
    const server = await start();

    for (const url of [
      '/api/internal/overview',
      '/api/internal/export/events.csv',
      '/api/internal/accounts/any/timeline',
    ]) {
      const response = await api(server.app, { method: 'GET', url });
      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('not_found');
    }
  });

  it('answers unknown API paths with JSON 404, never the SPA shell', async () => {
    const server = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { accept: 'text/html' },
    });

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(errorCode(response)).toBe('not_found');
  });
});
