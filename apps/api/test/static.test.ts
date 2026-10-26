import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SPA_MARKER, createFixture, type Fixture } from './helpers.js';

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
  const config = loadConfig(fixture.env);
  app = await buildApp({ config, version: '9.9.9-test' });
  return app;
}

const HTML_ACCEPT = { accept: 'text/html,application/xhtml+xml' };

describe('same-origin SPA hosting', () => {
  it('serves the built index.html at the root', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/', headers: HTML_ACCEPT });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain(SPA_MARKER);
  });

  it('serves hashed assets from the build output', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.body).toContain('oel-app');
  });

  it('returns the SPA shell for a client-side deep link (no auth gate yet — B3)', async () => {
    const server = await start();

    const response = await server.inject({
      method: 'GET',
      url: '/experiments/math.functions',
      headers: HTML_ACCEPT,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain(SPA_MARKER);
  });

  it('does not hand HTML to a request that explicitly asks for JSON', async () => {
    const server = await start();

    const response = await server.inject({
      method: 'GET',
      url: '/experiments/math.functions',
      headers: { accept: 'application/json' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(SPA_MARKER);
  });

  it('returns a plain 404 for a missing asset instead of the SPA shell', async () => {
    const server = await start();

    const response = await server.inject({
      method: 'GET',
      url: '/assets/does-not-exist.js',
      headers: HTML_ACCEPT,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(SPA_MARKER);
  });

  it.each(['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2f..%2fpackage.json'])(
    'refuses path traversal %j',
    async (url) => {
      const server = await start();

      const response = await server.inject({ method: 'GET', url, headers: HTML_ACCEPT });

      // @fastify/static answers traversal attempts with 403, the fallback with 404;
      // either way the file outside the build output must not be served.
      expect([403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('"name": "openedulab"');
    },
  );

  it('does not answer non-GET deep links with the SPA shell', async () => {
    const server = await start();

    const response = await server.inject({
      method: 'POST',
      url: '/experiments/math.functions',
      headers: HTML_ACCEPT,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(SPA_MARKER);
  });

  it('adds nosniff to static responses', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
