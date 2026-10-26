import type { DatabaseSync } from 'node:sqlite';

/**
 * Data access for `favorite` (schema: migrations/0001_init.sql, design §5.3).
 *
 * Every statement is scoped by `account_id`, which always comes from the session — there
 * is no query here that can read or delete another account's row, so cross-account access
 * is structurally impossible rather than merely rejected.
 */

export interface FavoriteRecord {
  readonly experimentId: string;
  readonly createdAt: number;
}

interface FavoriteRow {
  experiment_id: string;
  created_at: number;
}

export function listFavorites(db: DatabaseSync, accountId: string): FavoriteRecord[] {
  const rows = db
    .prepare(
      'SELECT experiment_id, created_at FROM favorite WHERE account_id = ? ' +
        'ORDER BY created_at DESC, experiment_id ASC',
    )
    .all(accountId) as unknown as FavoriteRow[];
  return rows.map((row) => ({ experimentId: row.experiment_id, createdAt: row.created_at }));
}

/**
 * Idempotent add: an existing row keeps its original timestamp, so a double click cannot
 * reorder the list or make the UI think it saved something new.
 */
export function addFavorite(
  db: DatabaseSync,
  accountId: string,
  experimentId: string,
  createdAt: number,
): { readonly createdAt: number; readonly created: boolean } {
  const existing = db
    .prepare('SELECT created_at FROM favorite WHERE account_id = ? AND experiment_id = ?')
    .get(accountId, experimentId) as unknown as { created_at: number } | undefined;
  if (existing !== undefined) {
    return { createdAt: existing.created_at, created: false };
  }
  db.prepare('INSERT INTO favorite (account_id, experiment_id, created_at) VALUES (?, ?, ?)').run(
    accountId,
    experimentId,
    createdAt,
  );
  return { createdAt, created: true };
}

/** Idempotent removal; returns whether a row was actually deleted. */
export function removeFavorite(
  db: DatabaseSync,
  accountId: string,
  experimentId: string,
): boolean {
  const result = db
    .prepare('DELETE FROM favorite WHERE account_id = ? AND experiment_id = ?')
    .run(accountId, experimentId);
  return Number(result.changes) > 0;
}
