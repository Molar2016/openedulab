import { afterEach, describe, expect, it } from 'vitest';

import { api, cookieHeader, errorCode, register, startAuthHarness, type AuthHarness } from './support/auth-app.js';

/**
 * `GET /api/experiments/:experimentId` (design §7.2): metadata for one indexed
 * experiment, session-gated, 404 for anything not published.
 */

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function start() {
  harness = await startAuthHarness();
  const server = harness;
  const created = await register(server.app, { identifier: 'teacher@example.com' });
  expect(created.status).toBe(201);
  return { server, cookie: cookieHeader(created.cookie()) };
}

describe('experiment metadata', () => {
  it('returns the indexed manifest, content version and localized text', async () => {
    const { server, cookie } = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/experiments/math.functions?locale=en',
      headers: cookie,
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      id: 'math.functions',
      slug: 'math-functions',
      contentVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      sdkVersionRange: expect.stringMatching(/^\^\d+\.\d+\.\d+$/),
      languages: ['zh-CN', 'en'],
      updatedAt: expect.any(Number),
    });
    const body = response.body as unknown as Record<string, unknown>;
    expect(typeof body.title).toBe('string');
    expect(typeof body.description).toBe('string');
    expect(body.title).not.toBe('');
  });

  it('answers 404 for an experiment that is not in the index', async () => {
    const { server, cookie } = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/experiments/physics.nope',
      headers: cookie,
    });

    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe('not_found');
  });

  it.each(['Math.Functions', 'math', 'math..functions', 'math.functions%2F..%2Fetc'])(
    'answers 400 for malformed id %s, never a filesystem lookup',
    async (id) => {
      const { server, cookie } = await start();

      const response = await api(server.app, {
        method: 'GET',
        url: `/api/experiments/${id}`,
        headers: cookie,
      });

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('validation_failed');
    },
  );

  it('requires a session', async () => {
    const { server } = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/experiments/math.functions',
    });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });
});
