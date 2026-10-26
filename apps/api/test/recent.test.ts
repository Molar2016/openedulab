import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  errorCode,
  register,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';
import { CATALOG_FIXTURE, writeContentDir } from './support/content.js';

/**
 * Recent use (design §7.4, R-13).
 *
 * The list is de-duplicated by resource through the primary key (account_id,
 * experiment_id) and stores only "which resource, when". It must never contain slider
 * values, parameter names or a per-drag trail — the whole point of the separate table.
 */

interface RecentItem {
  experimentId: string;
  lastOpenedAt: number;
}

interface RecentBody {
  items: RecentItem[];
}

let harness: AuthHarness | null = null;
let contentRoot: string | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
  if (contentRoot !== null) {
    await rm(contentRoot, { recursive: true, force: true });
    contentRoot = null;
  }
});

async function startWithThreeExperiments() {
  contentRoot = await mkdtemp(path.join(tmpdir(), 'oel-content-'));
  const contentDir = await writeContentDir(contentRoot, CATALOG_FIXTURE);
  harness = await startAuthHarness({ OEL_CONTENT_DIR: contentDir });
  const server = harness;
  const created = await register(server.app, { identifier: 'owner@example.com' });
  expect(created.status).toBe(201);
  return { server, cookie: cookieHeader(created.cookie()) };
}

async function record(
  server: AuthHarness,
  cookie: Record<string, string>,
  experimentId: string,
) {
  return api(server.app, {
    method: 'POST',
    url: '/api/me/recent',
    headers: cookie,
    payload: { experimentId },
  });
}

async function listRecent(server: AuthHarness, cookie: Record<string, string>, query = '') {
  const response = await api(server.app, {
    method: 'GET',
    url: `/api/me/recent${query}`,
    headers: cookie,
  });
  return {
    status: response.status,
    body: response.body as unknown as RecentBody,
    text: response.text,
    headers: response.headers,
  };
}

describe('recent use requires a session', () => {
  it.each([
    { method: 'GET' as const, url: '/api/me/recent' },
    { method: 'POST' as const, url: '/api/me/recent' },
  ])('$method $url denies anonymous callers', async ({ method, url }) => {
    const server = await startAuthHarness();
    harness = server;

    const response = await api(server.app, {
      method,
      url,
      ...(method === 'POST' ? { payload: { experimentId: 'math.functions' } } : {}),
    });

    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('recent use is de-duplicated by resource', () => {
  it('keeps one row per experiment and moves it to the top', async () => {
    const { server, cookie } = await startWithThreeExperiments();
    const base = server.clock.value;

    expect((await record(server, cookie, 'math.functions')).status).toBe(204);

    server.clock.value = base + 1_000;
    expect((await record(server, cookie, 'physics.freefall')).status).toBe(204);

    server.clock.value = base + 2_000;
    expect((await record(server, cookie, 'math.functions')).status).toBe(204);

    const list = await listRecent(server, cookie);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    // Two resources, not three opens, and the re-opened one is newest.
    expect(list.body.items.map((item) => item.experimentId)).toEqual([
      'math.functions',
      'physics.freefall',
    ]);
    expect(list.body.items[0]?.lastOpenedAt).toBe(base + 2_000);
    expect(list.body.items[1]?.lastOpenedAt).toBe(base + 1_000);
  });

  it('returns only the resource id and the timestamp', async () => {
    const { server, cookie } = await startWithThreeExperiments();
    await record(server, cookie, 'math.functions');

    const list = await listRecent(server, cookie);
    const item = list.body.items[0] as unknown as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(['experimentId', 'lastOpenedAt']);
    // No parameter values, no payload column, no user identity.
    expect(list.text).not.toMatch(/coefficient|slider|param|payload|account|@example/);
  });

  it('honours limit and rejects an invalid one', async () => {
    const { server, cookie } = await startWithThreeExperiments();
    const base = server.clock.value;
    for (const [index, id] of ['math.functions', 'math.geometry', 'physics.freefall'].entries()) {
      server.clock.value = base + index * 1_000;
      await record(server, cookie, id);
    }

    expect((await listRecent(server, cookie, '?limit=2')).body.items).toHaveLength(2);
    expect((await listRecent(server, cookie, '?limit=0')).status).toBe(400);
    expect((await listRecent(server, cookie, '?limit=51')).status).toBe(400);
    expect((await listRecent(server, cookie, '?unexpected=1')).status).toBe(400);
  });

  it('rejects an experiment that is not in the index, and a malformed id', async () => {
    const { server, cookie } = await startWithThreeExperiments();

    const unknown = await record(server, cookie, 'physics.nope');
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe('not_found');

    const malformed = await record(server, cookie, 'Math_Functions');
    expect(malformed.status).toBe(400);

    const missing = await api(server.app, {
      method: 'POST',
      url: '/api/me/recent',
      headers: cookie,
      payload: {},
    });
    expect(missing.status).toBe(400);
  });

  it('rejects a body that tries to name an account', async () => {
    const { server, cookie } = await startWithThreeExperiments();

    const response = await api(server.app, {
      method: 'POST',
      url: '/api/me/recent',
      headers: cookie,
      payload: { experimentId: 'math.functions', accountId: 'someone-else' },
    });

    expect(response.status).toBe(400);
    expect((await listRecent(server, cookie)).body.items).toEqual([]);
  });

  it('requires the CSRF guard on the write', async () => {
    const { server, cookie } = await startWithThreeExperiments();

    const response = await api(server.app, {
      method: 'POST',
      url: '/api/me/recent',
      headers: cookie,
      payload: { experimentId: 'math.functions' },
      origin: 'https://evil.example',
    });

    expect(response.status).toBe(403);
    expect((await listRecent(server, cookie)).body.items).toEqual([]);
  });

  it('keeps two accounts separate', async () => {
    const { server, cookie } = await startWithThreeExperiments();
    const other = await register(server.app, { identifier: 'other@example.com' });
    const otherCookie = cookieHeader(other.cookie());

    await record(server, cookie, 'math.functions');

    expect((await listRecent(server, otherCookie)).body.items).toEqual([]);
  });
});
