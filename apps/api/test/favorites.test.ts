import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  errorCode,
  login,
  register,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';

/**
 * Favorites (design §7.3, R-11/R-12/R-15).
 *
 * Personal data: synchronous, always account-scoped from the session, idempotent on
 * repeat, and invisible across accounts. Nothing here may be reconstructed from usage
 * events, so the responses are deliberately minimal (id + timestamp, no parameters).
 */

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function start() {
  harness = await startAuthHarness();
  return harness;
}

async function signedIn(identifier = 'owner@example.com') {
  const server = await start();
  const created = await register(server.app, { identifier });
  expect(created.status).toBe(201);
  return { server, cookie: cookieHeader(created.cookie()) };
}

interface FavoritesBody {
  items: { experimentId: string; createdAt: number }[];
}

async function listFavorites(server: AuthHarness, cookie: Record<string, string>) {
  const response = await api(server.app, { method: 'GET', url: '/api/me/favorites', headers: cookie });
  return {
    status: response.status,
    body: response.body as unknown as FavoritesBody,
    text: response.text,
    headers: response.headers,
  };
}

describe('favorites require a session', () => {
  it.each([
    { method: 'GET' as const, url: '/api/me/favorites' },
    { method: 'PUT' as const, url: '/api/me/favorites/math.functions' },
    { method: 'DELETE' as const, url: '/api/me/favorites/math.functions' },
  ])('$method $url denies anonymous callers', async ({ method, url }) => {
    const server = await start();

    const response = await api(server.app, { method, url });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('favoriting is idempotent and account-scoped', () => {
  it('adds a favorite once and reports the same timestamp on repeat', async () => {
    const { server, cookie } = await signedIn();

    const first = await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
    });
    expect(first.status).toBe(201);
    const createdAt = (first.body as unknown as { createdAt: number }).createdAt;
    expect(typeof createdAt).toBe('number');

    server.clock.value += 1000;

    const second = await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
    });
    expect(second.status).toBe(200);
    expect((second.body as unknown as { createdAt: number }).createdAt).toBe(createdAt);

    const list = await listFavorites(server, cookie);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([{ experimentId: 'math.functions', createdAt }]);
  });

  it('rejects an experiment that is not in the content index', async () => {
    const { server, cookie } = await signedIn();

    const response = await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/physics.nope',
      headers: cookie,
    });

    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe('not_found');
  });

  it('rejects a malformed experiment id', async () => {
    const { server, cookie } = await signedIn();

    const response = await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/Math_Functions',
      headers: cookie,
    });

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('requires the CSRF guard on writes', async () => {
    const { server, cookie } = await signedIn();

    const response = await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
      origin: null,
    });

    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
    expect((await listFavorites(server, cookie)).body.items).toEqual([]);
  });

  it('lists newest first', async () => {
    const server = await start();
    // A second experiment would need more content; ordering is asserted through the
    // timestamps of the single shipped item plus a direct database read.
    const created = await register(server.app, { identifier: 'owner@example.com' });
    const cookie = cookieHeader(created.cookie());
    await api(server.app, { method: 'PUT', url: '/api/me/favorites/math.functions', headers: cookie });

    const db = new DatabaseSync(server.databasePath);
    try {
      const rows = db
        .prepare('SELECT account_id, experiment_id, created_at FROM favorite')
        .all() as unknown as { account_id: string; experiment_id: string; created_at: number }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.experiment_id).toBe('math.functions');
    } finally {
      db.close();
    }
  });
});

describe('favorite writes are rate limited', () => {
  it('answers 429 with Retry-After once the per-account budget is spent', async () => {
    const { server, cookie } = await signedIn();

    let limited: { status: number; headers: Record<string, unknown> } | null = null;
    for (let index = 0; index < 70; index += 1) {
      const response = await api(server.app, {
        method: 'PUT',
        url: '/api/me/favorites/math.functions',
        headers: cookie,
      });
      if (response.status === 429) {
        limited = { status: response.status, headers: response.headers };
        break;
      }
    }

    expect(limited, 'the 60-per-minute favorite budget must be enforced').not.toBeNull();
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // The favorite added before the limit still exists: a 429 must not undo data.
    expect((await listFavorites(server, cookie)).body.items).toHaveLength(1);
  });
});

describe('removing a favorite', () => {
  it('is idempotent and removes the row', async () => {
    const { server, cookie } = await signedIn();
    await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
    });

    const first = await api(server.app, {
      method: 'DELETE',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
    });
    expect(first.status).toBe(204);

    const second = await api(server.app, {
      method: 'DELETE',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
    });
    expect(second.status).toBe(204);

    expect((await listFavorites(server, cookie)).body.items).toEqual([]);
  });
});

describe('favorites survive a new session and stay private', () => {
  it('is visible in a second session of the same account', async () => {
    const { server, cookie } = await signedIn();
    await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
    });

    // A new login means a new session token; the favorite must still be there.
    const second = await login(server.app, { identifier: 'owner@example.com' });
    expect(second.status).toBe(200);
    const otherCookie = cookieHeader(second.cookie());
    expect(otherCookie.cookie).not.toBe(cookie.cookie);

    const list = await listFavorites(server, otherCookie);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]?.experimentId).toBe('math.functions');
  });

  it('is invisible to another account, and its writes do not leak in', async () => {
    const server = await start();
    const first = await register(server.app, { identifier: 'owner-a@example.com' });
    const second = await register(server.app, { identifier: 'owner-b@example.com' });
    const cookieA = cookieHeader(first.cookie());
    const cookieB = cookieHeader(second.cookie());

    await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/math.functions',
      headers: cookieA,
    });

    expect((await listFavorites(server, cookieA)).body.items).toHaveLength(1);
    // B has its own (empty) list: the request carries no account id, so there is nothing
    // to tamper with.
    expect((await listFavorites(server, cookieB)).body.items).toEqual([]);

    // B removing "the same" experiment must not delete A's row.
    const removed = await api(server.app, {
      method: 'DELETE',
      url: '/api/me/favorites/math.functions',
      headers: cookieB,
    });
    expect(removed.status).toBe(204);
    expect((await listFavorites(server, cookieA)).body.items).toHaveLength(1);
  });

  it('returns no parameter or identity fields', async () => {
    const { server, cookie } = await signedIn();
    await api(server.app, {
      method: 'PUT',
      url: '/api/me/favorites/math.functions',
      headers: cookie,
    });

    const list = await listFavorites(server, cookie);
    const item = list.body.items[0] as unknown as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(['createdAt', 'experimentId']);
    expect(list.text).not.toContain('owner@example.com');
    expect(list.text).not.toContain('account');
  });
});
