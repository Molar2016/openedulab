import type { DatabaseSync } from 'node:sqlite';

/**
 * Data retention (design §9.4, D13).
 *
 * This is deliberately *not* an HTTP endpoint. Deleting history is a maintenance action
 * taken by whoever holds the database file, not something a caller can trigger over the
 * wire: `scripts/retention-purge.mjs` is the only way in, it defaults to a dry run, and
 * `--apply` additionally has to repeat the database path.
 *
 * The windows come from the design and are an accepted loss: there is no daily rollup
 * table, so once events are purged, per-day trends cannot be recomputed (risk R7).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionId = 'event' | 'feedback' | 'internal_audit' | 'session';

export interface RetentionRule {
  readonly id: RetentionId;
  readonly table: string;
  /** Column(s) the cutoff is applied to, for the report. */
  readonly columns: string;
  readonly maxAgeDays: number;
  readonly predicate: string;
  readonly note: string;
}

export const RETENTION_RULES: readonly RetentionRule[] = Object.freeze([
  {
    id: 'event',
    table: 'event',
    columns: 'occurred_at_min',
    maxAgeDays: 90,
    predicate: 'occurred_at_min < ?',
    note: 'Diagnostic events older than 90 days; no rollup exists, so they are unrecoverable.',
  },
  {
    id: 'feedback',
    table: 'feedback',
    columns: 'created_at',
    maxAgeDays: 180,
    predicate: 'created_at < ?',
    note: 'Feedback older than 180 days, including its free text.',
  },
  {
    id: 'internal_audit',
    table: 'internal_audit',
    columns: 'created_at',
    maxAgeDays: 365,
    predicate: 'created_at < ?',
    note: 'Operator audit trail older than 365 days.',
  },
  {
    id: 'session',
    table: 'session',
    columns: 'revoked_at, expires_at',
    maxAgeDays: 30,
    predicate: '(revoked_at IS NOT NULL AND revoked_at < ?) OR (revoked_at IS NULL AND expires_at < ?)',
    note: 'Sessions that ended more than 30 days ago (revoked or expired). Live sessions are never touched.',
  },
]);

export interface RetentionRow {
  readonly id: RetentionId;
  readonly table: string;
  readonly columns: string;
  readonly maxAgeDays: number;
  readonly cutoff: number;
  readonly plannedRows: number;
  readonly deletedRows: number;
  readonly note: string;
}

export interface RetentionReport {
  readonly generatedAt: number;
  readonly mode: 'dry-run' | 'apply';
  readonly rules: readonly RetentionRow[];
  readonly totalPlanned: number;
  readonly totalDeleted: number;
}

function cutoffFor(rule: RetentionRule, now: number): number {
  return now - rule.maxAgeDays * DAY_MS;
}

function placeholderCount(predicate: string): number {
  return predicate.split('?').length - 1;
}

function countMatching(db: DatabaseSync, rule: RetentionRule, cutoff: number): number {
  const statement = db.prepare(
    `SELECT COUNT(*) AS total FROM ${rule.table} WHERE ${rule.predicate}`,
  );
  const params = new Array<number>(placeholderCount(rule.predicate)).fill(cutoff);
  const row = statement.get(...params) as unknown as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/**
 * Counts what a purge *would* delete and touches nothing. Safe on a live database:
 * a single read-only COUNT per rule.
 */
export function planRetention(db: DatabaseSync, now: number): RetentionReport {
  const rules = RETENTION_RULES.map((rule) => {
    const cutoff = cutoffFor(rule, now);
    return {
      id: rule.id,
      table: rule.table,
      columns: rule.columns,
      maxAgeDays: rule.maxAgeDays,
      cutoff,
      plannedRows: countMatching(db, rule, cutoff),
      deletedRows: 0,
      note: rule.note,
    };
  });
  return {
    generatedAt: now,
    mode: 'dry-run',
    rules,
    totalPlanned: rules.reduce((sum, row) => sum + row.plannedRows, 0),
    totalDeleted: 0,
  };
}

/**
 * Deletes rows past their retention window in a single transaction, so a failure in the
 * middle leaves the database as it was. Running it twice is a no-op for everything it
 * already deleted, which is what makes it safe to schedule (and to re-run after a crash).
 */
export function purgeRetention(db: DatabaseSync, now: number): RetentionReport {
  const planned = planRetention(db, now);
  const deleted = new Map<RetentionId, number>();

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const rule of RETENTION_RULES) {
      const cutoff = cutoffFor(rule, now);
      const statement = db.prepare(`DELETE FROM ${rule.table} WHERE ${rule.predicate}`);
      const params = new Array<number>(placeholderCount(rule.predicate)).fill(cutoff);
      const result = statement.run(...params);
      deleted.set(rule.id, Number(result.changes));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const rules = planned.rules.map((row) => ({
    ...row,
    deletedRows: deleted.get(row.id) ?? 0,
  }));
  return {
    generatedAt: now,
    mode: 'apply',
    rules,
    totalPlanned: planned.totalPlanned,
    totalDeleted: rules.reduce((sum, row) => sum + row.deletedRows, 0),
  };
}
