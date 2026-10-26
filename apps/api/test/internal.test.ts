import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { api, cookieHeader, errorCode, register, startAuthHarness, type AuthHarness } from './support/auth-app.js';

/**
 * Operator channel (design §7.8, R-14/R-20/R-23).
 *
 * It answers the questions the product actually asks — which resources are used, do
 * people start interacting, which controls get used, where do errors cluster — and it is
 * reachable only with the environment-configured Bearer token. A normal account gets the
 * same 404 as an anonymous visitor: the channel does not exist for users.
 *
 * Account-scoped reads and every CSV export must leave an `internal_audit` row, because
 * "minimum scope, purpose, retention" is only credible if it is written down.
 */

const OPERATOR_TOKEN = 'test-operator-token-0123456789';
const OPERATOR_LABEL = 'owner-laptop';
const REASON = 'investigating a reported rendering problem';

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function start(options: Record<string, string> = {}) {
  harness = await startAuthHarness({ OEL_OPERATOR_TOKEN: OPERATOR_TOKEN, ...options });
  return harness;
}

function operatorHeaders(): Record<string, string> {
  // The purpose travels in the query string (design §7.8), the operator label in a header.
  return {
    authorization: `Bearer ${OPERATOR_TOKEN}`,
    'x-operator-label': OPERATOR_LABEL,
  };
}

function window_(server: AuthHarness): string {
  return `from=${String(server.clock.value - 3_600_000)}&to=${String(server.clock.value + 3_600_000)}`;
}

async function seedEvents(server: AuthHarness) {
  const first = await register(server.app, { identifier: 'teacher-a@example.com' });
  const second = await register(server.app, { identifier: 'teacher-b@example.com' });
  const cookieA = cookieHeader(first.cookie());

  // One visit per account: the visit_id is what makes "opened but never interacted"
  // computable, so two browsers must not share it.
  const send = async (cookie: Record<string, string>, visitId: string, events: unknown[]) =>
    api(server.app, {
      method: 'POST',
      url: '/api/events',
      headers: cookie,
      payload: { schemaVersion: 1, appVersion: '0.1.0-m1', visitId, events },
    });

  const base = {
    experimentId: 'math.functions',
    contentVersion: '1.0.0',
    locale: 'en',
  };
  await send(cookieA, 'visit-seed-a-01', [
    { clientEventId: 'seed-a-001', type: 'experiment_open', ...base },
    { clientEventId: 'seed-a-002', type: 'experiment_first_interaction', ...base },
    { clientEventId: 'seed-a-003', type: 'experiment_control_used', ...base, controlGroup: 'a', interactionBucket: '2-5' },
    { clientEventId: 'seed-a-004', type: 'experiment_reset', ...base },
  ]);
  await send(cookieHeader(second.cookie()), 'visit-seed-b-01', [
    { clientEventId: 'seed-b-001', type: 'experiment_open', ...base },
    { clientEventId: 'seed-b-002', type: 'client_error', ...base, errorCode: 'render_error' },
  ]);

  return { first, second, cookieA };
}

function auditRows(databasePath: string) {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare('SELECT operator_label, action, target_type, target_id, reason, row_count FROM internal_audit')
      .all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe('the operator channel is closed to everyone else', () => {
  it.each([
    '/api/internal/overview',
    '/api/internal/experiments/math.functions/funnel',
    '/api/internal/accounts/any/timeline',
    '/api/internal/export/events.csv',
    '/api/internal/export/feedback.csv',
  ])('%s is a 404 without a token', async (url) => {
    const server = await start();

    const response = await api(server.app, { method: 'GET', url: `${url}?${window_(server)}` });

    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe('not_found');
  });

  it('rejects a wrong token, a scheme confusion and a normal account session', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher@example.com' });
    const cookie = cookieHeader(created.cookie());

    for (const headers of [
      { authorization: 'Bearer not-the-token' },
      { authorization: OPERATOR_TOKEN },
      { authorization: `Basic ${OPERATOR_TOKEN}` },
      cookie,
    ]) {
      const response = await api(server.app, {
        method: 'GET',
        url: `/api/internal/overview?${window_(server)}`,
        headers,
      });
      expect(response.status, JSON.stringify(headers)).toBe(404);
    }
  });

  it('is not mounted at all when no token is configured', async () => {
    const server = await start({ OEL_OPERATOR_TOKEN: '' });

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/overview?${window_(server)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(404);
  });
});

describe('overview answers the product questions', () => {
  it('reports distinct accounts, visits, interaction conversion and error counts', async () => {
    const server = await start();
    await seedEvents(server);

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/overview?${window_(server)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(200);
    const body = response.body as unknown as {
      window: { from: number; to: number };
      generatedAt: number;
      dataGaps: unknown[];
      experiments: {
        experimentId: string;
        openAccounts: number;
        openVisits: number;
        interactedVisits: number;
        firstInteractionRate: number;
        resets: number;
        errors: number;
      }[];
    };
    expect(body.window.from).toBe(server.clock.value - 3_600_000);
    expect(body.generatedAt).toBe(server.clock.value);
    expect(body.dataGaps).toEqual([]);

    const experiment = body.experiments.find((entry) => entry.experimentId === 'math.functions');
    expect(experiment).toMatchObject({
      openAccounts: 2,
      openVisits: 2,
      interactedVisits: 1,
      resets: 1,
      errors: 1,
    });
    // One of two opens produced a first interaction.
    expect(experiment?.firstInteractionRate).toBeCloseTo(0.5, 5);
  });

  it('rejects a malformed or oversized window', async () => {
    const server = await start();

    for (const query of [
      'from=abc&to=def',
      'from=10&to=5',
      `from=${String(server.clock.value - 200 * 24 * 3600_000)}&to=${String(server.clock.value)}`,
      'from=0&to=0',
    ]) {
      const response = await api(server.app, {
        method: 'GET',
        url: `/api/internal/overview?${query}`,
        headers: operatorHeaders(),
      });
      expect(response.status, query).toBe(400);
    }
  });

  it('flags the window as unknown when event ingestion is off', async () => {
    const server = await start({ OEL_EVENTS_ENABLED: 'false' });

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/overview?${window_(server)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(200);
    const body = response.body as unknown as { dataGaps: { reason: string }[]; experiments: unknown[] };
    expect(body.dataGaps).toEqual([{ reason: 'events_disabled', from: expect.any(Number), to: expect.any(Number) }]);
    expect(body.experiments).toEqual([]);
  });
});

describe('funnel and control distribution', () => {
  it('counts each step and the controls that were actually used', async () => {
    const server = await start();
    await seedEvents(server);

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/experiments/math.functions/funnel?${window_(server)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(200);
    const body = response.body as unknown as {
      experimentId: string;
      counts: Record<string, number>;
      controls: { controlGroup: string; events: number; accounts: number }[];
    };
    expect(body.experimentId).toBe('math.functions');
    expect(body.counts.experiment_open).toBe(2);
    expect(body.counts.experiment_first_interaction).toBe(1);
    expect(body.counts.client_error).toBe(1);
    expect(body.controls).toEqual([{ controlGroup: 'a', events: 1, accounts: 1 }]);
  });

  it('answers 404 for an experiment that is not published', async () => {
    const server = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/experiments/physics.nope/funnel?${window_(server)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(404);
  });
});

describe('single-account timeline is scoped and audited', () => {
  it('returns only that account\'s events and records the access', async () => {
    const server = await start();
    await seedEvents(server);

    const accounts = new DatabaseSync(server.databasePath);
    const accountId = (accounts.prepare("SELECT id FROM account WHERE normalized_login = 'teacher-a@example.com'").get() as { id: string }).id;
    accounts.close();

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/accounts/${accountId}/timeline?${window_(server)}&reason=${encodeURIComponent(REASON)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(200);
    const body = response.body as unknown as {
      accountId: string;
      items: { eventType: string; experimentId: string }[];
      truncated: boolean;
    };
    expect(body.accountId).toBe(accountId);
    // Order inside one minute is not meaningful (occurred_at_min is minute-granular),
    // so the set is asserted; ordering is by receive time, which the API guarantees.
    expect(body.items.map((item) => item.eventType).sort()).toEqual(
      [
        'experiment_control_used',
        'experiment_first_interaction',
        'experiment_open',
        'experiment_reset',
      ].sort(),
    );
    expect(body.items.every((item) => item.experimentId === 'math.functions')).toBe(true);
    expect(body.truncated).toBe(false);

    const audit = auditRows(server.databasePath);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operator_label: OPERATOR_LABEL,
      action: 'account_timeline',
      target_type: 'account',
      target_id: accountId,
      reason: REASON,
      row_count: 4,
    });
  });

  it('requires a purpose and an operator label', async () => {
    const server = await start();

    const noReason = await api(server.app, {
      method: 'GET',
      url: `/api/internal/accounts/whatever/timeline?${window_(server)}`,
      headers: operatorHeaders(),
    });
    expect(noReason.status).toBe(400);

    const shortReason = await api(server.app, {
      method: 'GET',
      url: `/api/internal/accounts/whatever/timeline?${window_(server)}&reason=short`,
      headers: operatorHeaders(),
    });
    expect(shortReason.status).toBe(400);

    const noLabel = await api(server.app, {
      method: 'GET',
      url: `/api/internal/accounts/whatever/timeline?${window_(server)}&reason=${encodeURIComponent(REASON)}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(noLabel.status).toBe(400);
    expect(auditRows(server.databasePath)).toEqual([]);
  });
});

describe('CSV export', () => {
  it('exports events without user agents or receive timestamps, and audits it', async () => {
    const server = await start();
    await seedEvents(server);

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/export/events.csv?${window_(server)}&reason=${encodeURIComponent(REASON)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toContain('attachment');

    const lines = response.text.trim().split('\n');
    expect(lines[0]).toBe(
      'occurred_at_min,experiment_id,content_version,app_version,locale,event_type,control_group,interaction_bucket,error_code,device_class,account_id',
    );
    expect(lines.length).toBe(7); // header + 6 seeded rows
    expect(response.text).not.toContain('received_at');
    expect(response.text).not.toContain('Mozilla');
    expect(response.text).not.toContain('teacher-a@example.com');

    const audit = auditRows(server.databasePath);
    expect(audit[0]).toMatchObject({ action: 'export_events', row_count: 6 });
  });

  it('exports feedback with the account id and the reported text', async () => {
    const server = await start();
    const created = await register(server.app, { identifier: 'teacher-a@example.com' });
    const cookie = cookieHeader(created.cookie());
    const submitted = await api(server.app, {
      method: 'POST',
      url: '/api/feedback',
      headers: cookie,
      payload: {
        experimentId: 'math.functions',
        contentVersion: '1.0.0',
        appVersion: '0.1.0-m1',
        category: 'confusing',
        message: 'The vertex label overlaps the axis',
      },
    });
    expect(submitted.status).toBe(201);

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/export/feedback.csv?${window_(server)}&reason=${encodeURIComponent(REASON)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(200);
    const lines = response.text.trim().split('\n');
    expect(lines[0]).toBe(
      'id,created_at,experiment_id,content_version,app_version,category,message,account_id',
    );
    expect(lines[1]).toContain('confusing');
    expect(lines[1]).toContain('The vertex label overlaps the axis');
    expect(lines[1]).toMatch(/[0-9a-f-]{36}$/);

    expect(auditRows(server.databasePath)[0]).toMatchObject({
      action: 'export_feedback',
      row_count: 1,
    });
  });

  it('requires a reason for every export', async () => {
    const server = await start();

    const response = await api(server.app, {
      method: 'GET',
      url: `/api/internal/export/events.csv?${window_(server)}`,
      headers: operatorHeaders(),
    });

    expect(response.status).toBe(400);
    expect(auditRows(server.databasePath)).toEqual([]);
  });
});
