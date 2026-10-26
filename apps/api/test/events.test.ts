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

/**
 * Diagnostic events (design §6.1, §7.6, R-22).
 *
 * The endpoint is deliberately narrow: a fixed event whitelist, a fixed control
 * whitelist, a server clock, and a server-derived account. Anything else the client sends
 * is counted as `dropped` — never stored, never echoed. These tests exist because the
 * easiest way to ruin this table is to "just add one more field".
 */

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const VISIT_ID = 'visit-0f0c4a6e-1a2b';

function envelope(events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    appVersion: '0.1.0-m1',
    visitId: VISIT_ID,
    events,
    ...overrides,
  };
}

function openEvent(clientEventId = 'ce-open-1') {
  return {
    clientEventId,
    type: 'experiment_open',
    experimentId: 'math.functions',
    contentVersion: '1.0.0',
    locale: 'en',
  };
}

async function start() {
  harness = await startAuthHarness();
  const server = harness;
  const created = await register(server.app, { identifier: 'teacher@example.com' });
  expect(created.status).toBe(201);
  return { server, cookie: cookieHeader(created.cookie()) };
}

async function post(server: AuthHarness, cookie: Record<string, string>, body: unknown) {
  return api(server.app, { method: 'POST', url: '/api/events', headers: cookie, payload: body });
}

function eventRows(databasePath: string) {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare(
        'SELECT account_id, experiment_id, content_version, app_version, locale, event_type, ' +
          'control_group, interaction_bucket, error_code, issue_category, device_class, ' +
          'visit_id, client_event_id, dedupe_key, occurred_at_min, received_at FROM event',
      )
      .all() as unknown as Record<string, string | number | null>[];
  } finally {
    db.close();
  }
}

describe('events require a session', () => {
  it('denies anonymous callers', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/events',
      payload: envelope([openEvent()]),
    });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });
});

describe('accepted events', () => {
  it('stores a whitelisted open event with a server timestamp and account', async () => {
    const { server, cookie } = await start();

    const response = await post(server, cookie, envelope([openEvent()]));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: 1, dropped: 0 });
    const rows = eventRows(server.databasePath);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.event_type).toBe('experiment_open');
    expect(row.content_version).toBe('1.0.0');
    expect(row.occurred_at_min).toBe(Math.floor(server.clock.value / 60_000) * 60_000);
    expect(row.received_at).toBe(server.clock.value);
    expect(row.dedupe_key).toBe(`${VISIT_ID}:experiment_open:`);
    expect(typeof row.account_id).toBe('string');
  });

  it('derives the device class from the user agent instead of storing it', async () => {
    const { server, cookie } = await start();
    await post(server, cookie, envelope([openEvent()]));

    const response = await api(server.app, {
      method: 'POST',
      url: '/api/events',
      headers: {
        ...cookie,
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      },
      payload: envelope([{ ...openEvent('ce-phone'), type: 'experiment_reset' }]),
    });
    expect(response.status).toBe(202);

    const rows = eventRows(server.databasePath);
    const mobile = rows.find((row) => row.client_event_id === 'ce-phone');
    expect(mobile?.device_class).toBe('mobile');
    // The raw user agent never reaches the row.
    expect(JSON.stringify(rows)).not.toContain('iPhone');
  });

  it('treats reset and fullscreen as repeatable and the rest as once per visit', async () => {
    const { server, cookie } = await start();

    const first = await post(
      server,
      cookie,
      envelope([
        openEvent('ce-reset-01'),
        { ...openEvent('ce-reset-02'), type: 'experiment_reset' },
        {
          clientEventId: 'ce-full-03',
          type: 'experiment_fullscreen',
          experimentId: 'math.functions',
          contentVersion: '1.0.0',
          locale: 'en',
          controlGroup: 'fullscreen_enter',
        },
      ]),
    );
    expect(first.body).toMatchObject({ accepted: 3, dropped: 0 });

    // A second reset in the same visit is a new row; a second open is not.
    const second = await post(
      server,
      cookie,
      envelope([
        { ...openEvent('ce-reset-04'), type: 'experiment_reset' },
        openEvent('ce-reset-05'),
      ]),
    );
    expect(second.body).toMatchObject({ accepted: 1, dropped: 1 });

    const rows = eventRows(server.databasePath);
    expect(rows.filter((row) => row.event_type === 'experiment_reset')).toHaveLength(2);
    expect(rows.filter((row) => row.event_type === 'experiment_open')).toHaveLength(1);
    // Repeatable events carry no dedupe key, so a NULL never collides.
    expect(rows.filter((row) => row.event_type === 'experiment_reset').every((row) => row.dedupe_key === null)).toBe(true);
  });

  it('drops a repeated client event id instead of failing', async () => {
    const { server, cookie } = await start();
    await post(server, cookie, envelope([openEvent('ce-same-01')]));

    const again = await post(server, cookie, envelope([openEvent('ce-same-01')]));

    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ accepted: 0, dropped: 1 });
    expect(eventRows(server.databasePath)).toHaveLength(1);
  });
});

describe('rejected event payloads', () => {
  it('drops free text, slider values, URLs and unknown fields without storing them', async () => {
    const { server, cookie } = await start();

    const response = await post(
      server,
      cookie,
      envelope([
        {
          ...openEvent('ce-evil-01'),
          message: 'my student Wang Wei was confused, call 13800001234',
          sliderValue: 0.3729,
          url: 'https://evil.example/experiments/math.functions?token=abc123',
          name: 'Wang Wei',
        },
      ]),
    );

    expect(response.status).toBe(202);
    const rows = eventRows(server.databasePath);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('Wang Wei');
    expect(serialized).not.toContain('0.3729');
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('13800001234');
    expect(serialized).not.toContain('token=abc123');
  });

  it.each([
    ['unknown type', { type: 'experiment_complete' }],
    ['unknown experiment', { experimentId: 'physics.nope' }],
    ['version mismatch', { contentVersion: '9.9.9' }],
    ['bad control group', { type: 'experiment_control_used', controlGroup: 'sliderValue' }],
    ['bad interaction bucket', { type: 'experiment_control_used', controlGroup: 'a', interactionBucket: '999' }],
    ['bad error code', { type: 'client_error', errorCode: 'free_text_error' }],
    ['missing error code', { type: 'client_error' }],
    ['bad locale', { locale: 'fr' }],
  ])('drops a %s event', async (_label, patch) => {
    const { server, cookie } = await start();

    const response = await post(server, cookie, envelope([{ ...openEvent('ce-bad-01'), ...patch }]));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: 0, dropped: 1 });
    expect(eventRows(server.databasePath)).toEqual([]);
  });

  it('rejects a malformed envelope outright', async () => {
    const { server, cookie } = await start();

    for (const body of [
      { schemaVersion: 2, appVersion: '0.1.0', visitId: VISIT_ID, events: [openEvent()] },
      { schemaVersion: 1, visitId: VISIT_ID, events: [openEvent()] },
      envelope([], { events: [] }),
      envelope([openEvent()], { visitId: 'short' }),
      envelope(Array.from({ length: 21 }, (_, index) => openEvent(`ce-${index}`))),
      envelope([openEvent()], { unexpected: 'field' }),
    ]) {
      const response = await post(server, cookie, body);
      expect(response.status).toBe(400);
    }
    expect(eventRows(server.databasePath)).toEqual([]);
  });

  it('refuses a batch larger than the body limit', async () => {
    const { server, cookie } = await start();

    const response = await post(
      server,
      cookie,
      envelope([openEvent('ce-big-01')], { padding: 'x'.repeat(16_000) }),
    );

    expect([400, 413]).toContain(response.status);
  });
});

describe('event ingestion controls', () => {
  it('rate limits per account and keeps what it already accepted', async () => {
    const { server, cookie } = await start();

    let limited = 0;
    for (let index = 0; index < 130; index += 1) {
      const response = await post(
        server,
        cookie,
        envelope([{ ...openEvent(`ce-rl-${String(index).padStart(3, '0')}`), type: 'experiment_reset' }]),
      );
      if (response.status === 429) {
        limited += 1;
        expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        break;
      }
    }
    expect(limited, 'the 120/minute event budget must be enforced').toBe(1);
    expect(eventRows(server.databasePath).length).toBeGreaterThan(0);
  });

  it('accepts the batch but stores nothing when events are disabled', async () => {
    harness = await startAuthHarness({ OEL_EVENTS_ENABLED: 'false' });
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = cookieHeader(created.cookie());

    const response = await post(harness, cookie, envelope([openEvent()]));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: 0, dropped: 1 });
    expect(eventRows(harness.databasePath)).toEqual([]);
  });
});
