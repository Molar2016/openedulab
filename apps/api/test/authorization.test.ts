import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  errorCode,
  register,
  SESSION_COOKIE,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';

/**
 * B3 authorization gate (design §3.3, §7.2; R-05).
 *
 * The invariant under test is structural: a private API route answers only when a live,
 * server-side session cookie is presented. Nothing else — no query parameter, no header,
 * no forged cookie, no "the SPA hides it" — may reach protected content.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Routes that must be protected in B3 (implemented protected surface). */
const PRIVATE_ENDPOINTS: readonly { readonly url: string }[] = [
  { url: '/api/catalog' },
  { url: '/api/experiments/math.functions' },
];

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function start(): Promise<AuthHarness> {
  harness = await startAuthHarness();
  return harness;
}

function withDb(databasePath: string, sql: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(sql).run();
  } finally {
    db.close();
  }
}

describe('private routes reject anonymous callers', () => {
  for (const endpoint of PRIVATE_ENDPOINTS) {
    it(`GET ${endpoint.url} answers 401 unauthenticated without a cookie`, async () => {
      const server = await start();

      const response = await api(server.app, { method: 'GET', url: endpoint.url });

      expect(response.status).toBe(401);
      expect(errorCode(response)).toBe('unauthenticated');
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['cache-control']).toBe('no-store');
      // No resource metadata may leak in the denial.
      expect(response.text).not.toContain('math.functions');
    });

    it(`GET ${endpoint.url} answers 401 for a forged cookie`, async () => {
      const server = await start();

      for (const value of [
        'forged-token',
        'A'.repeat(43),
        '..%2F..%2Fetc%2Fpasswd',
        "'; DROP TABLE session; --",
      ]) {
        const response = await api(server.app, {
          method: 'GET',
          url: endpoint.url,
          headers: { cookie: `${SESSION_COOKIE}=${value}` },
        });
        expect(response.status).toBe(401);
        expect(errorCode(response)).toBe('unauthenticated');
      }
    });

    it(`GET ${endpoint.url} ignores caller-supplied identity fields`, async () => {
      const server = await start();
      const created = await register(server.app, { identifier: 'owner-a@example.com' });

      // A header that pretends to name an account must not authenticate anybody.
      const response = await api(server.app, {
        method: 'GET',
        url: endpoint.url,
        headers: { 'x-account-id': 'anyones-id', 'x-account': 'owner-a@example.com' },
      });

      expect(response.status).toBe(401);
      expect(created.status).toBe(201);
    });
  }
});

describe('a live session grants access', () => {
  it('serves the catalog to the account that just registered', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    expect(created.status).toBe(201);

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/catalog',
      headers: cookieHeader(created.cookie()),
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.body as unknown as {
      items?: { id?: string; contentVersion?: string }[];
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items?.map((item) => item.id)).toContain('math.functions');
    expect(body.items?.every((item) => typeof item.contentVersion === 'string')).toBe(true);
  });

  it('serves experiment metadata without leaking identity or filesystem paths', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/experiments/math.functions',
      headers: cookieHeader(created.cookie()),
    });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('manifest.json');
    expect(response.text).not.toContain('password');
    expect(response.text).not.toContain('teacher@example.com');
    expect(response.text).not.toContain('accountId');
  });

  it('keeps the session working across requests and processes no account id in the body', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    const cookie = cookieHeader(created.cookie());

    const first = await api(server.app, { method: 'GET', url: '/api/catalog', headers: cookie });
    const second = await api(server.app, { method: 'GET', url: '/api/catalog', headers: cookie });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('the gate follows server-side session state', () => {
  it('rejects the cookie after logout', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    const cookie = cookieHeader(created.cookie());

    const before = await api(server.app, { method: 'GET', url: '/api/catalog', headers: cookie });
    expect(before.status).toBe(200);

    const loggedOut = await api(server.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookie,
      payload: {},
    });
    expect(loggedOut.status).toBe(204);

    const after = await api(server.app, { method: 'GET', url: '/api/catalog', headers: cookie });
    expect(after.status).toBe(401);
    expect(errorCode(after)).toBe('unauthenticated');
  });

  it('rejects an absolutely expired session', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    const cookie = cookieHeader(created.cookie());

    server.clock.value += 61 * DAY_MS;

    const response = await api(server.app, { method: 'GET', url: '/api/catalog', headers: cookie });
    expect(response.status).toBe(401);
  });

  it('rejects an idle-expired session even inside the absolute window', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    const cookie = cookieHeader(created.cookie());

    server.clock.value += 15 * DAY_MS;

    const response = await api(server.app, { method: 'GET', url: '/api/catalog', headers: cookie });
    expect(response.status).toBe(401);
  });

  it('rejects a session whose account was disabled', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });

    withDb(server.databasePath, "UPDATE account SET status = 'disabled'");

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/catalog',
      headers: cookieHeader(created.cookie()),
    });
    expect(response.status).toBe(401);
  });

  it('rejects a session row deleted from the database', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });

    withDb(server.databasePath, 'DELETE FROM session');

    const response = await api(server.app, {
      method: 'GET',
      url: '/api/catalog',
      headers: cookieHeader(created.cookie()),
    });
    expect(response.status).toBe(401);
  });
});
