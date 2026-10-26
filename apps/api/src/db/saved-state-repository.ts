import type { DatabaseSync } from 'node:sqlite';

/**
 * `saved_state` access (design §5.5). One row per (account, experiment): the snapshot is
 * overwritten, not versioned. Every statement is scoped by `account_id`, which the route
 * derives from the session — there is no code path that reads a row by experiment alone.
 */

export interface SavedStateRow {
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly stateSchemaVersion: number;
  /** Canonical JSON string as it was validated before storage. */
  readonly payload: string;
  readonly updatedAt: number;
}

interface RawRow {
  experiment_id: string;
  content_version: string;
  state_schema_version: number;
  payload: string;
  updated_at: number;
}

export function getSavedState(
  db: DatabaseSync,
  accountId: string,
  experimentId: string,
): SavedStateRow | undefined {
  const row = db
    .prepare(
      'SELECT experiment_id, content_version, state_schema_version, payload, updated_at ' +
        'FROM saved_state WHERE account_id = ? AND experiment_id = ?',
    )
    .get(accountId, experimentId) as RawRow | undefined;
  if (row === undefined) return undefined;
  return {
    experimentId: row.experiment_id,
    contentVersion: row.content_version,
    stateSchemaVersion: Number(row.state_schema_version),
    payload: row.payload,
    updatedAt: Number(row.updated_at),
  };
}

export interface SaveStateInput {
  readonly contentVersion: string;
  readonly stateSchemaVersion: number;
  readonly payload: string;
  readonly updatedAt: number;
}

/** Upserts the single snapshot and returns the timestamp that is actually stored. */
export function putSavedState(
  db: DatabaseSync,
  accountId: string,
  experimentId: string,
  input: SaveStateInput,
): number {
  db.prepare(
    'INSERT INTO saved_state (account_id, experiment_id, content_version, state_schema_version, payload, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (account_id, experiment_id) DO UPDATE SET ' +
      'content_version = excluded.content_version, ' +
      'state_schema_version = excluded.state_schema_version, ' +
      'payload = excluded.payload, ' +
      'updated_at = excluded.updated_at',
  ).run(
    accountId,
    experimentId,
    input.contentVersion,
    input.stateSchemaVersion,
    input.payload,
    input.updatedAt,
  );
  return input.updatedAt;
}

/** Idempotent: deleting something that was never saved is not an error. */
export function deleteSavedState(db: DatabaseSync, accountId: string, experimentId: string): void {
  db.prepare('DELETE FROM saved_state WHERE account_id = ? AND experiment_id = ?').run(
    accountId,
    experimentId,
  );
}
