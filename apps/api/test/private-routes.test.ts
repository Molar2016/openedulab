import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createFixture, type Fixture } from './helpers.js';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

async function start(): Promise<FastifyInstance> {
  fixture = await createFixture();
  app = await buildApp({ config: loadConfig(fixture.env), version: '9.9.9-test' });
  return app;
}

/**
 * Routes that will require a session once B2/B3 exist. Until then they must deny
 * every caller — the placeholder is a denial, never an unauthenticated resource.
 */
const PRIVATE_ROUTES: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }[] = [
  { method: 'GET', url: '/api/catalog' },
  { method: 'GET', url: '/api/experiments/math.functions' },
  { method: 'GET', url: '/api/me/favorites' },
  { method: 'PUT', url: '/api/me/favorites/math.functions' },
  { method: 'DELETE', url: '/api/me/favorites/math.functions' },
  { method: 'GET', url: '/api/me/recent' },
  { method: 'POST', url: '/api/me/recent' },
  { method: 'GET', url: '/api/me/saved-state/math.functions' },
  { method: 'PUT', url: '/api/me/saved-state/math.functions' },
  { method: 'DELETE', url: '/api/me/saved-state/math.functions' },
  { method: 'POST', url: '/api/events' },
  { method: 'POST', url: '/api/feedback' },
];

describe('private API placeholders', () => {
  it.each(PRIVATE_ROUTES)('$method $url is denied with 401 unauthenticated', async ({ method, url }) => {
    const server = await start();

    const response = await server.inject({ method, url });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      error: {
        code: 'unauthenticated',
        message: expect.stringContaining('not implemented'),
      },
    });
  });

  it('denies even when the client forges a session cookie (there is no session layer yet)', async () => {
    const server = await start();

    const response = await server.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { cookie: 'oel_sid=forged-token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('does not expose an operator channel while no operator token is configured', async () => {
    const server = await start();

    for (const url of ['/api/internal/overview', '/api/internal/export/events.csv']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      });
    }
  });

  /**
   * Superseded by B2: while no session layer existed, this route had to be a plain 404
   * so nobody could mistake a stub for a session. B2 now mounts the real endpoint, so the
   * assertion becomes: it answers honestly ("not authenticated"), never a fake session.
   */
  it('serves /api/auth/session as an honest unauthenticated answer after B2', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/api/auth/session' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns JSON 404 for unknown API routes and never the SPA shell', async () => {
    const server = await start();

    const response = await server.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json().error.code).toBe('not_found');
  });
});
