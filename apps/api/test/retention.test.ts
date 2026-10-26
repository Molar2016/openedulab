import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { planRetention, purgeRetention } from '../src/domain/retention.js';
import { register, startAuthHarness, type AuthHarness } from './support/auth-app.js';

/**
 * Retention CLI (design §9.4, B8).
 *
 * Three separate guarantees are tested here:
 * 1. The cutoffs are exact — a row one millisecond inside the window survives, so the
 *    purge cannot slowly eat data that is still in scope.
 * 2. A dry run changes nothing, `--apply` deletes exactly what the plan counted, and a
 *    second run is a no-op (safe to schedule, safe to re-run after a crash).
 * 3. Deletion is not reachable over HTTP, and `--apply` refuses to run without naming the
 *    same database twice. That is the authorization boundary, not a warning message.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'retention-purge.mjs');
const DAY_MS = 24 * 60 * 60 * 1000;

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

interface Fixture {
  readonly server: AuthHarness;
  readonly now: number;
  readonly accountId: string;
}

/** Seeds one row per side of every cutoff, against a fixed clock. */
async function seed(): Promise<Fixture> {
  harness = await startAuthHarness();
  const server = harness;
  const created = await register(server.app, { identifier: 'retention@example.com' });
  expect(created.status).toBe(201);

  const now = server.clock.value;
  const db = new DatabaseSync(server.databasePath);
  try {
    const account = db.prepare('SELECT id FROM account LIMIT 1').get() as unknown as { id: string };
    const accountId = account.id;

    let counter = 0;
    const event = (occurredAtMin: number): void => {
      counter += 1;
      db.prepare(
        'INSERT INTO event (id, account_id, experiment_id, content_version, app_version, locale, ' +
          'event_type, control_group, interaction_bucket, error_code, issue_category, device_class, ' +
          'visit_id, client_event_id, dedupe_key, occurred_at_min, received_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        `evt-${String(counter)}`,
        accountId,
        'math.functions',
        '1.0.0',
        '0.1.0-m1',
        'en',
        'experiment_open',
        '',
        '',
        '',
        '',
        'desktop',
        `visit-${String(counter)}`,
        `client-${String(counter)}`,
        `dedupe-${String(counter)}`,
        occurredAtMin,
        occurredAtMin,
      );
    };
    event(now - 91 * DAY_MS);
    event(now - 90 * DAY_MS); // exactly at the cutoff: kept (strict `<`)
    event(now - 10 * DAY_MS);

    db.prepare(
      'INSERT INTO feedback (id, account_id, experiment_id, content_version, app_version, category, message, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('fb-old', accountId, 'math.functions', '1.0.0', '0.1.0-m1', 'bug', 'old', now - 181 * DAY_MS);
    db.prepare(
      'INSERT INTO feedback (id, account_id, experiment_id, content_version, app_version, category, message, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('fb-new', accountId, 'math.functions', '1.0.0', '0.1.0-m1', 'bug', 'new', now - DAY_MS);

    db.prepare(
      'INSERT INTO internal_audit (id, operator_label, action, target_type, target_id, reason, row_count, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('audit-old', 'owner-laptop', 'export_events', 'window', 'x', 'retention fixture', 1, now - 366 * DAY_MS);
    db.prepare(
      'INSERT INTO internal_audit (id, operator_label, action, target_type, target_id, reason, row_count, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('audit-new', 'owner-laptop', 'export_events', 'window', 'x', 'retention fixture', 1, now - DAY_MS);

    const session = (
      id: string,
      revokedAt: number | null,
      expiresAt: number,
    ): void => {
      db.prepare(
        'INSERT INTO session (id, account_id, token_hash, created_at, last_seen_at, expires_at, revoked_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, accountId, `hash-${id}`, now - 400 * DAY_MS, now - 400 * DAY_MS, expiresAt, revokedAt);
    };
    session('sess-revoked-old', now - 31 * DAY_MS, now - 31 * DAY_MS);
    session('sess-revoked-new', now - 2 * DAY_MS, now - 2 * DAY_MS);
    session('sess-expired-old', null, now - 31 * DAY_MS);
    session('sess-expired-new', null, now - DAY_MS);
    // The registration's own live session must survive every rule.

    return { server, now, accountId };
  } finally {
    db.close();
  }
}

function counts(server: AuthHarness): Record<string, number> {
  const db = new DatabaseSync(server.databasePath);
  try {
    const tables = ['event', 'feedback', 'internal_audit', 'session'];
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as unknown as {
        total: number;
      };
      result[table] = Number(row.total);
    }
    return result;
  } finally {
    db.close();
  }
}

describe('retention plan', () => {
  it('counts only rows strictly past each window and changes nothing', async () => {
    const { server, now } = await seed();
    const before = counts(server);

    const db = new DatabaseSync(server.databasePath);
    let report;
    try {
      report = planRetention(db, now);
    } finally {
      db.close();
    }

    const byId = Object.fromEntries(report.rules.map((rule) => [rule.id, rule.plannedRows]));
    expect(byId).toEqual({ event: 1, feedback: 1, internal_audit: 1, session: 2 });
    expect(report.totalPlanned).toBe(5);
    expect(report.mode).toBe('dry-run');
    expect(counts(server)).toEqual(before);
  });
});

describe('retention purge', () => {
  it('deletes exactly the planned rows and keeps everything inside the window', async () => {
    const { server, now } = await seed();
    const before = counts(server);

    const db = new DatabaseSync(server.databasePath);
    let report;
    try {
      report = purgeRetention(db, now);
    } finally {
      db.close();
    }

    expect(report.mode).toBe('apply');
    expect(report.totalDeleted).toBe(report.totalPlanned);
    const after = counts(server);
    expect(after.event).toBe(before.event - 1);
    expect(after.feedback).toBe(before.feedback - 1);
    expect(after.internal_audit).toBe(before.internal_audit - 1);
    expect(after.session).toBe(before.session - 2);

    const check = new DatabaseSync(server.databasePath);
    try {
      const survivors = check
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('event', 'feedback')")
        .all();
      expect(survivors.length).toBe(2);
      const eventTimes = check
        .prepare('SELECT occurred_at_min FROM event ORDER BY occurred_at_min')
        .all() as unknown as { occurred_at_min: number }[];
      expect(eventTimes.map((row) => row.occurred_at_min)).toEqual([
        now - 90 * DAY_MS,
        now - 10 * DAY_MS,
      ]);
      const sessions = check
        .prepare('SELECT id FROM session ORDER BY id')
        .all() as unknown as { id: string }[];
      const sessionIds = sessions.map((row) => row.id);
      expect(sessionIds).toContain('sess-expired-new');
      expect(sessionIds).toContain('sess-revoked-new');
      expect(sessionIds.filter((id) => id.startsWith('sess-'))).toHaveLength(2);
      // The registration's own live session is still there.
      expect(sessionIds).toHaveLength(3);
    } finally {
      check.close();
    }
  });

  it('is idempotent: a second run deletes nothing', async () => {
    const { server, now } = await seed();

    const db = new DatabaseSync(server.databasePath);
    try {
      purgeRetention(db, now);
      const second = purgeRetention(db, now);
      expect(second.totalPlanned).toBe(0);
      expect(second.totalDeleted).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('retention authorization boundary', () => {
  it('has no HTTP endpoint for deletion', async () => {
    const { server } = await seed();

    expect(server.app.routeInventory.map((entry) => entry.url).filter((url) => url.includes('retention'))).toEqual([]);
  });

  it('refuses --apply without naming the same database twice', async () => {
    const { server } = await seed();

    const withoutConfirm = spawnSync(process.execPath, [CLI_PATH, '--db', server.databasePath, '--apply'], {
      encoding: 'utf8',
    });
    expect(withoutConfirm.status).toBe(2);
    expect(withoutConfirm.stderr).toContain('--confirm-database');
    expect(withoutConfirm.stdout).toBe('');

    const mismatched = spawnSync(
      process.execPath,
      [CLI_PATH, '--db', server.databasePath, '--apply', '--confirm-database', `${server.databasePath}.other`],
      { encoding: 'utf8' },
    );
    expect(mismatched.status).toBe(2);
    expect(mismatched.stderr).toContain('does not match');

    // Nothing was deleted by either refusal.
    const after = counts(server);
    expect(after.event).toBeGreaterThanOrEqual(3);
  });

  it('runs a dry run when no mode is given', async () => {
    const { server } = await seed();
    const before = counts(server);

    const dryRun = spawnSync(process.execPath, [CLI_PATH, '--db', server.databasePath], {
      encoding: 'utf8',
    });

    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain('retention dry-run');
    expect(dryRun.stdout).toContain('would delete');
    expect(counts(server)).toEqual(before);
  });
});
