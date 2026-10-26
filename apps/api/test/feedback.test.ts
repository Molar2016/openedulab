import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { api, cookieHeader, errorCode, register, startAuthHarness, type AuthHarness } from './support/auth-app.js';

/**
 * Feedback (design §7.7, §6.1).
 *
 * This is the only path that accepts free text, and it goes to the `feedback` table only —
 * never into `event`. The row keeps the account id and the content/app versions so a
 * report can be reproduced, and the matching `feedback_submitted` event carries the
 * category only.
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

function body(patch: Record<string, unknown> = {}) {
  return {
    experimentId: 'math.functions',
    contentVersion: '1.0.0',
    appVersion: '0.1.0-m1',
    category: 'bug',
    message: 'The reset button did not respond',
    ...patch,
  };
}

async function submit(server: AuthHarness, cookie: Record<string, string>, payload: unknown) {
  return api(server.app, { method: 'POST', url: '/api/feedback', headers: cookie, payload });
}

function rows(databasePath: string, table: 'feedback' | 'event') {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe('feedback requires a session', () => {
  it('denies anonymous callers', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, { method: 'POST', url: '/api/feedback', payload: body() });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });
});

describe('accepting a report', () => {
  it('stores the message in feedback only and records a category event', async () => {
    const { server, cookie } = await start();

    const response = await submit(server, cookie, body({ category: 'confusing', message: 'Vertex label overlaps' }));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: expect.any(String) });

    const feedback = rows(server.databasePath, 'feedback');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      experiment_id: 'math.functions',
      content_version: '1.0.0',
      app_version: '0.1.0-m1',
      category: 'confusing',
      message: 'Vertex label overlaps',
    });
    expect(feedback[0]?.created_at).toBe(server.clock.value);

    const events = rows(server.databasePath, 'event');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'feedback_submitted',
      issue_category: 'confusing',
      control_group: '',
    });
    // The free text must not reach the event table.
    expect(JSON.stringify(events)).not.toContain('Vertex label overlaps');
  });

  it('accepts a category-only report with no message', async () => {
    const { server, cookie } = await start();

    const response = await submit(server, cookie, body({ message: undefined }));

    expect(response.status).toBe(201);
    expect(rows(server.databasePath, 'feedback')[0]?.message).toBeNull();
  });

  it('strips control characters and collapses an over-long message instead of failing', async () => {
    const { server, cookie } = await start();

    const response = await submit(
      server,
      cookie,
      body({ message: `first line\u0000\u0007 second\u0008\n${'x'.repeat(2500)}` }),
    );

    expect(response.status).toBe(201);
    const message = String(rows(server.databasePath, 'feedback')[0]?.message ?? '');
    const controlCharacters = [...message].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    });
    expect(controlCharacters).toEqual([]);
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message.startsWith('first line')).toBe(true);
  });

  it.each([
    ['unknown category', { category: 'praise' }],
    ['malformed experiment', { experimentId: 'Math_Functions' }],
    ['unpublished experiment', { experimentId: 'physics.nope' }],
    ['unknown field', { accountId: 'someone' }],
    ['non-integer version', { contentVersion: 'v1' }],
  ])('rejects a %s', async (_label, patch) => {
    const { server, cookie } = await start();

    const response = await submit(server, cookie, body(patch));

    expect(response.status).toBe(400);
    expect(rows(server.databasePath, 'feedback')).toEqual([]);
  });

  it('requires the CSRF guard', async () => {
    const { server, cookie } = await start();

    const response = await api(server.app, {
      method: 'POST',
      url: '/api/feedback',
      headers: cookie,
      payload: body(),
      origin: 'https://evil.example',
    });

    expect(response.status).toBe(403);
    expect(rows(server.databasePath, 'feedback')).toEqual([]);
  });

  it('limits submissions per account', async () => {
    const { server, cookie } = await start();

    let limited = false;
    for (let index = 0; index < 8; index += 1) {
      const response = await submit(server, cookie, body({ message: `report ${String(index)}` }));
      if (response.status === 429) {
        limited = true;
        expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        break;
      }
    }

    expect(limited, 'the 5-per-hour feedback budget must be enforced').toBe(true);
  });
});
