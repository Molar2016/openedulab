import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  errorCode,
  register,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';
import { buildApp } from '../src/app.js';
import { writeContentDir } from './support/content.js';
import { loadConfig } from '../src/config.js';

/**
 * Saved parameter snapshots (design §7.5, R-17/R-18).
 *
 * Lifecycle under test: nothing is written until the user asks for it, one snapshot per
 * (account, experiment), readable only by that account, deletable, and rejected unless it
 * matches the experiment's declared schema and byte budget. The values are personal data,
 * so they must never show up in the diagnostic event table.
 */

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const VALID_VALUES = { mode: 'linear', a: 3, b: -2, c: 0.5 } as const;

interface SavedStateBody {
  experimentId?: string;
  contentVersion?: string;
  stateSchemaVersion?: number;
  values?: Record<string, string | number>;
  updatedAt?: number;
}

async function signedIn(identifier = 'owner@example.com') {
  harness = await startAuthHarness();
  const created = await register(harness.app, { identifier });
  expect(created.status).toBe(201);
  return { server: harness, cookie: cookieHeader(created.cookie()) };
}

function get(server: AuthHarness, cookie: Record<string, string>, experimentId = 'math.functions') {
  return api(server.app, {
    method: 'GET',
    url: `/api/me/saved-state/${experimentId}`,
    headers: cookie,
  }).then(shape);
}

function put(
  server: AuthHarness,
  cookie: Record<string, string>,
  payload: unknown,
  experimentId = 'math.functions',
) {
  return api(server.app, {
    method: 'PUT',
    url: `/api/me/saved-state/${experimentId}`,
    headers: cookie,
    payload,
  }).then(shape);
}

function remove(server: AuthHarness, cookie: Record<string, string>, experimentId = 'math.functions') {
  return api(server.app, {
    method: 'DELETE',
    url: `/api/me/saved-state/${experimentId}`,
    headers: cookie,
  }).then(shape);
}

async function shape(response: Awaited<ReturnType<typeof api>>) {
  return {
    status: response.status,
    body: response.body as unknown as SavedStateBody,
    text: response.text,
    headers: response.headers,
    code: errorCode(response),
  };
}

function rows(databasePath: string): { account_id: string; payload: string; content_version: string }[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare('SELECT account_id, payload, content_version FROM saved_state')
      .all() as unknown as { account_id: string; payload: string; content_version: string }[];
  } finally {
    db.close();
  }
}

function eventCount(databasePath: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe('saved state requires a session', () => {
  it.each([
    { method: 'GET' as const, url: '/api/me/saved-state/math.functions' },
    { method: 'PUT' as const, url: '/api/me/saved-state/math.functions' },
    { method: 'DELETE' as const, url: '/api/me/saved-state/math.functions' },
  ])('$method $url denies anonymous callers', async ({ method, url }) => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method,
      url,
      ...(method === 'PUT' ? { payload: { stateSchemaVersion: 1, values: VALID_VALUES } } : {}),
    });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(rows(harness.databasePath)).toHaveLength(0);
  });

  it('denies a forged session cookie', async () => {
    harness = await startAuthHarness();
    const response = await api(harness.app, {
      method: 'GET',
      url: '/api/me/saved-state/math.functions',
      headers: { cookie: 'oel_sid=forged' },
    });
    expect(response.status).toBe(401);
  });
});

describe('saved state lifecycle', () => {
  it('reports 404 before anything is saved, and saving writes exactly one row', async () => {
    const { server, cookie } = await signedIn();

    const before = await get(server, cookie);
    expect(before.status).toBe(404);
    expect(before.code).toBe('not_found');
    expect(rows(server.databasePath)).toHaveLength(0);

    const saved = await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });
    expect(saved.status).toBe(200);
    expect(saved.body.experimentId).toBe('math.functions');
    expect(saved.body.contentVersion).toBe('1.0.0');
    expect(saved.body.stateSchemaVersion).toBe(1);
    expect(saved.body.values).toEqual(VALID_VALUES);
    expect(typeof saved.body.updatedAt).toBe('number');
    expect(saved.headers['cache-control']).toBe('no-store');

    const stored = rows(server.databasePath);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content_version).toBe('1.0.0');
    // Canonical JSON: sorted keys, no extra fields.
    expect(JSON.parse(stored[0]?.payload ?? '{}')).toEqual(VALID_VALUES);
    expect(stored[0]?.payload).toBe('{"a":3,"b":-2,"c":0.5,"mode":"linear"}');
  });

  it('reads back from a second process on the same database (not from memory)', async () => {
    const { server, cookie } = await signedIn();
    await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });

    // A separate Fastify instance, separate SQLite connection, same database file: this is
    // what a restart looks like, without killing the harness the other assertions use.
    const restarted = await buildApp({
      config: loadConfig(server.env),
      version: '9.9.9-test',
      now: () => server.clock.value,
    });
    try {
      const reread = await get({ ...server, app: restarted }, cookie);
      expect(reread.status).toBe(200);
      expect(reread.body.values).toEqual(VALID_VALUES);
    } finally {
      await restarted.close();
    }
  });

  it('overwrites the single snapshot instead of accumulating versions', async () => {
    const { server, cookie } = await signedIn();

    await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });
    const second = await put(server, cookie, {
      stateSchemaVersion: 1,
      values: { mode: 'quadratic', a: -1, b: 2, c: -3 },
    });

    expect(second.status).toBe(200);
    expect(second.body.values).toEqual({ mode: 'quadratic', a: -1, b: 2, c: -3 });
    expect(rows(server.databasePath)).toHaveLength(1);
    const reread = await get(server, cookie);
    expect(reread.body.values).toEqual({ mode: 'quadratic', a: -1, b: 2, c: -3 });
  });

  it('deletes the snapshot, is idempotent, and reports 404 afterwards', async () => {
    const { server, cookie } = await signedIn();
    await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });

    const first = await remove(server, cookie);
    expect(first.status).toBe(204);
    expect(rows(server.databasePath)).toHaveLength(0);

    const second = await remove(server, cookie);
    expect(second.status).toBe(204);

    const after = await get(server, cookie);
    expect(after.status).toBe(404);
  });
});

describe('saved state is account-scoped', () => {
  it('is invisible to another account, which cannot delete it either', async () => {
    harness = await startAuthHarness();
    const owner = await register(harness.app, { identifier: 'owner@example.com' });
    expect(owner.status).toBe(201);
    const ownerCookie = cookieHeader(owner.cookie());

    const other = await register(harness.app, { identifier: 'other@example.com' });
    expect(other.status).toBe(201);
    const otherCookie = cookieHeader(other.cookie());

    const saved = await put(harness, ownerCookie, { stateSchemaVersion: 1, values: VALID_VALUES });
    expect(saved.status).toBe(200);

    const otherRead = await get(harness, otherCookie);
    expect(otherRead.status).toBe(404);
    expect(otherRead.text).not.toContain('linear');

    const otherDelete = await remove(harness, otherCookie);
    expect(otherDelete.status).toBe(204);

    const ownerRead = await get(harness, ownerCookie);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.values).toEqual(VALID_VALUES);
  });
});

describe('saved state validation', () => {
  it.each([
    {
      label: 'an unknown key',
      payload: { stateSchemaVersion: 1, values: { ...VALID_VALUES, d: 9 } },
      code: 'state_invalid',
    },
    {
      label: 'a missing key',
      payload: { stateSchemaVersion: 1, values: { mode: 'linear', a: 1 } },
      code: 'state_invalid',
    },
    {
      label: 'a value above the declared maximum',
      payload: { stateSchemaVersion: 1, values: { ...VALID_VALUES, a: 10.1 } },
      code: 'state_invalid',
    },
    {
      label: 'a value off the declared step',
      payload: { stateSchemaVersion: 1, values: { ...VALID_VALUES, a: 0.15 } },
      code: 'state_invalid',
    },
    {
      label: 'a number sent as a string',
      payload: { stateSchemaVersion: 1, values: { ...VALID_VALUES, a: '3' } },
      code: 'state_invalid',
    },
    {
      label: 'an enum value outside the whitelist',
      payload: { stateSchemaVersion: 1, values: { ...VALID_VALUES, mode: 'cubic' } },
      code: 'state_invalid',
    },
    {
      label: 'a values payload that is an array',
      payload: { stateSchemaVersion: 1, values: [1, 2, 3] },
      code: 'validation_failed',
    },
    {
      label: 'an extra top-level field',
      payload: { stateSchemaVersion: 1, values: VALID_VALUES, experimentId: 'other.id' },
      code: 'validation_failed',
    },
    {
      label: 'a missing stateSchemaVersion',
      payload: { values: VALID_VALUES },
      code: 'validation_failed',
    },
    {
      label: 'a string stateSchemaVersion',
      payload: { stateSchemaVersion: '1', values: VALID_VALUES },
      code: 'validation_failed',
    },
  ])('rejects $label and stores nothing', async ({ payload, code }) => {
    const { server, cookie } = await signedIn();

    const response = await put(server, cookie, payload);

    expect(response.status).toBe(400);
    expect(response.code).toBe(code);
    expect(rows(server.databasePath)).toHaveLength(0);
    // The rejection must not echo the accepted shape back as if it had been stored.
    const after = await get(server, cookie);
    expect(after.status).toBe(404);
  });

  it('refuses a snapshot whose schema version the running server does not know', async () => {
    const { server, cookie } = await signedIn();

    const stale = await put(server, cookie, { stateSchemaVersion: 2, values: VALID_VALUES });

    expect(stale.status).toBe(409);
    expect(stale.code).toBe('state_schema_incompatible');
    expect(rows(server.databasePath)).toHaveLength(0);
  });

  it('rejects an experiment that is not in the content index', async () => {
    const { server, cookie } = await signedIn();

    const unknown = await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES }, 'math.nope');
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe('not_found');

    const read = await get(server, cookie, 'math.nope');
    expect(read.status).toBe(404);
  });

  it('rejects a malformed experiment id before touching the database', async () => {
    const { server, cookie } = await signedIn();
    const response = await api(server.app, {
      method: 'GET',
      url: '/api/me/saved-state/not%20an%20id',
      headers: cookie,
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });
});

describe('saved state honours the cross-site and rate-limit guards', () => {
  it('rejects a write with no Origin header and with a non-JSON content type', async () => {
    const { server, cookie } = await signedIn();

    const noOrigin = await api(server.app, {
      method: 'PUT',
      url: '/api/me/saved-state/math.functions',
      headers: cookie,
      payload: { stateSchemaVersion: 1, values: VALID_VALUES },
      origin: null,
    });
    expect(noOrigin.status).toBe(403);

    const formPost = await api(server.app, {
      method: 'PUT',
      url: '/api/me/saved-state/math.functions',
      headers: { ...cookie, 'content-type': 'text/plain' },
      payload: { stateSchemaVersion: 1, values: VALID_VALUES },
    });
    expect(formPost.status).toBe(403);
    expect(rows(server.databasePath)).toHaveLength(0);
  });

  it('rate-limits repeated saves with Retry-After and keeps the last good snapshot', async () => {
    const { server, cookie } = await signedIn();
    await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });

    let limited: Awaited<ReturnType<typeof put>> | null = null;
    for (let index = 0; index < 40; index += 1) {
      const response = await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited?.code).toBe('rate_limited');
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
    expect(rows(server.databasePath)).toHaveLength(1);
  });
});

describe('the startup content index owns the state schema', () => {
  it('indexes a declared schema from state-schema.json and validates against it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oel-content-state-'));
    try {
      const contentDir = await writeContentDir(root, [
        {
          id: 'math.functions',
          slug: 'math-functions',
          titleEn: 'Fixture',
          titleZh: '夹具',
          stateSchema: {
            schemaVersion: 4,
            fields: { a: { kind: 'number', min: 0, max: 5, step: 1, default: 1 } },
          },
        },
      ]);
      harness = await startAuthHarness({ OEL_CONTENT_DIR: contentDir });
      const created = await register(harness.app, { identifier: 'fixture@example.com' });
      const cookie = cookieHeader(created.cookie());

      const ok = await put(harness, cookie, { stateSchemaVersion: 4, values: { a: 4 } });
      expect(ok.status).toBe(200);
      expect(ok.body.stateSchemaVersion).toBe(4);

      // The fixture's own bounds are enforced, not the shipped experiment's.
      const tooBig = await put(harness, cookie, { stateSchemaVersion: 4, values: { a: 6 } });
      expect(tooBig.status).toBe(400);
      expect(tooBig.code).toBe('state_invalid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to start when the deployed state-schema.json is invalid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oel-content-bad-state-'));
    try {
      const contentDir = await writeContentDir(root, [
        {
          id: 'math.functions',
          slug: 'math-functions',
          titleEn: 'Fixture',
          titleZh: '夹具',
          stateSchema: { schemaVersion: 0, fields: {} },
        },
      ]);
      await expect(startAuthHarness({ OEL_CONTENT_DIR: contentDir })).rejects.toThrow(
        /state-schema\.json/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('saved state stays out of diagnostics', () => {
  it('writes no event when a snapshot is saved, read or deleted', async () => {
    const { server, cookie } = await signedIn();
    const before = eventCount(server.databasePath);

    await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });
    await get(server, cookie);
    await remove(server, cookie);

    expect(eventCount(server.databasePath)).toBe(before);
  });

  it('never stores the values in the event table even when a batch is sent', async () => {
    const { server, cookie } = await signedIn();
    await put(server, cookie, { stateSchemaVersion: 1, values: VALID_VALUES });

    const batch = await api(server.app, {
      method: 'POST',
      url: '/api/events',
      headers: cookie,
      payload: {
        schemaVersion: 1,
        appVersion: '9.9.9-test',
        visitId: 'visit-saved-state-1',
        events: [
          {
            clientEventId: 'saved-state-event-1',
            type: 'experiment_control_used',
            experimentId: 'math.functions',
            contentVersion: '1.0.0',
            locale: 'en',
            controlGroup: 'a',
            interactionBucket: '2-5',
          },
        ],
      },
    });
    expect(batch.status).toBe(202);

    const db = new DatabaseSync(server.databasePath);
    try {
      const text = JSON.stringify(
        db.prepare('SELECT * FROM event').all() as unknown as Record<string, unknown>[],
      );
      expect(text).toContain('experiment_control_used');
      // No parameter names or values leak into the diagnostic table.
      for (const needle of ['"mode"', 'linear', '"a":3', '"coef']) {
        expect(text).not.toContain(needle);
      }
    } finally {
      db.close();
    }
  });
});
