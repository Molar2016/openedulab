import type { DatabaseSync } from 'node:sqlite';

/**
 * `placement_saved_state` access (ADR-003).
 *
 * One row per (account, placement). Every statement is scoped by `account_id`, which the
 * route derives from the session, and the row is keyed by the *placement*, so two chapters
 * of the same tool are independent — there is no statement here that reads a row by tool id.
 *
 * This table is deliberately separate from `saved_state`: the tool-level snapshot (direct
 * entry) and the chapter-level snapshot must not be able to inherit each other's values.
 */

export interface PlacementStateRow {
  readonly placementId: string;
  readonly experimentId: string;
  readonly placementVersion: number;
  readonly contentVersion: string;
  readonly stateSchemaVersion: number;
  readonly payload: string;
  readonly updatedAt: number;
}

interface RawRow {
  placement_id: string;
  experiment_id: string;
  placement_version: number;
  content_version: string;
  state_schema_version: number;
  payload: string;
  updated_at: number;
}

export function getPlacementState(
  db: DatabaseSync,
  accountId: string,
  placementId: string,
): PlacementStateRow | undefined {
  const row = db
    .prepare(
      'SELECT placement_id, experiment_id, placement_version, content_version, ' +
        'state_schema_version, payload, updated_at FROM placement_saved_state ' +
        'WHERE account_id = ? AND placement_id = ?',
    )
    .get(accountId, placementId) as RawRow | undefined;
  if (row === undefined) return undefined;
  return {
    placementId: row.placement_id,
    experimentId: row.experiment_id,
    placementVersion: Number(row.placement_version),
    contentVersion: row.content_version,
    stateSchemaVersion: Number(row.state_schema_version),
    payload: row.payload,
    updatedAt: Number(row.updated_at),
  };
}

export interface PutPlacementStateInput {
  readonly experimentId: string;
  readonly placementVersion: number;
  readonly contentVersion: string;
  readonly stateSchemaVersion: number;
  readonly payload: string;
  readonly updatedAt: number;
}

/** Upserts this account's single snapshot for one placement. */
export function putPlacementState(
  db: DatabaseSync,
  accountId: string,
  placementId: string,
  input: PutPlacementStateInput,
): number {
  db.prepare(
    'INSERT INTO placement_saved_state (account_id, placement_id, experiment_id, ' +
      'placement_version, content_version, state_schema_version, payload, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (account_id, placement_id) DO UPDATE SET ' +
      'experiment_id = excluded.experiment_id, ' +
      'placement_version = excluded.placement_version, ' +
      'content_version = excluded.content_version, ' +
      'state_schema_version = excluded.state_schema_version, ' +
      'payload = excluded.payload, ' +
      'updated_at = excluded.updated_at',
  ).run(
    accountId,
    placementId,
    input.experimentId,
    input.placementVersion,
    input.contentVersion,
    input.stateSchemaVersion,
    input.payload,
    input.updatedAt,
  );
  return input.updatedAt;
}
