import type { DatabaseSync } from 'node:sqlite';

/**
 * Data access for `recent_use` (schema: migrations/0001_init.sql, design §5.4).
 *
 * One row per (account, experiment): opening the same experiment again only moves its
 * timestamp. There is no counter, no payload and no per-drag trail — "which resource, when
 * last" is the whole product requirement, and anything more would be a record of the
 * lesson rather than of the tool.
 */

export interface RecentUseRecord {
  readonly experimentId: string;
  readonly lastOpenedAt: number;
}

interface RecentUseRow {
  experiment_id: string;
  last_opened_at: number;
}

export function listRecentUse(
  db: DatabaseSync,
  accountId: string,
  limit: number,
): RecentUseRecord[] {
  const rows = db
    .prepare(
      'SELECT experiment_id, last_opened_at FROM recent_use WHERE account_id = ? ' +
        'ORDER BY last_opened_at DESC, experiment_id ASC LIMIT ?',
    )
    .all(accountId, limit) as unknown as RecentUseRow[];
  return rows.map((row) => ({
    experimentId: row.experiment_id,
    lastOpenedAt: row.last_opened_at,
  }));
}

/** Upsert: the primary key (account_id, experiment_id) is what de-duplicates the list. */
export function recordRecentUse(
  db: DatabaseSync,
  accountId: string,
  experimentId: string,
  openedAt: number,
): void {
  db.prepare(
    'INSERT INTO recent_use (account_id, experiment_id, last_opened_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (account_id, experiment_id) DO UPDATE SET last_opened_at = excluded.last_opened_at',
  ).run(accountId, experimentId, openedAt);
}
