import type { DatabaseSync } from 'node:sqlite';

import type { EventRow } from '../domain/events.js';

/**
 * Data access for `event` (schema: migrations/0001_init.sql, design §5.6).
 *
 * Write path: one INSERT with `ON CONFLICT DO NOTHING`, so the two unique indexes
 * (account+client_event_id, account+dedupe_key) implement retry idempotence and
 * once-per-visit de-duplication in the database rather than in application code.
 *
 * Read path: only the operator channel uses these queries, and each one is bounded by a
 * time window supplied by the caller.
 */

export function insertEvent(db: DatabaseSync, row: EventRow): boolean {
  const result = db
    .prepare(
      'INSERT INTO event (id, account_id, experiment_id, content_version, app_version, locale, ' +
        'event_type, control_group, interaction_bucket, error_code, issue_category, device_class, ' +
        'visit_id, client_event_id, dedupe_key, occurred_at_min, received_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
    .run(
      row.id,
      row.accountId,
      row.experimentId,
      row.contentVersion,
      row.appVersion,
      row.locale,
      row.eventType,
      row.controlGroup,
      row.interactionBucket,
      row.errorCode,
      row.issueCategory,
      row.deviceClass,
      row.visitId,
      row.clientEventId,
      row.dedupeKey,
      row.occurredAtMin,
      row.receivedAt,
    );
  return Number(result.changes) > 0;
}

export interface OverviewRow {
  readonly experimentId: string;
  readonly openAccounts: number;
  readonly openVisits: number;
  readonly interactedVisits: number;
  readonly opens: number;
  readonly resets: number;
  readonly fullscreens: number;
  readonly errors: number;
  readonly contentVersions: string;
}

/**
 * One row per experiment for the window. `COUNT(DISTINCT CASE ...)` keeps it a single
 * portable query instead of N per-experiment round trips.
 */
export function overviewRows(db: DatabaseSync, from: number, to: number): OverviewRow[] {
  const rows = db
    .prepare(
      'SELECT experiment_id, ' +
        "COUNT(DISTINCT CASE WHEN event_type = 'experiment_open' THEN account_id END) AS open_accounts, " +
        "COUNT(DISTINCT CASE WHEN event_type = 'experiment_open' THEN visit_id END) AS open_visits, " +
        "COUNT(DISTINCT CASE WHEN event_type = 'experiment_first_interaction' THEN visit_id END) AS interacted_visits, " +
        "SUM(CASE WHEN event_type = 'experiment_open' THEN 1 ELSE 0 END) AS opens, " +
        "SUM(CASE WHEN event_type = 'experiment_reset' THEN 1 ELSE 0 END) AS resets, " +
        "SUM(CASE WHEN event_type = 'experiment_fullscreen' THEN 1 ELSE 0 END) AS fullscreens, " +
        "SUM(CASE WHEN event_type = 'client_error' THEN 1 ELSE 0 END) AS errors, " +
        'GROUP_CONCAT(DISTINCT content_version) AS content_versions ' +
        'FROM event WHERE occurred_at_min >= ? AND occurred_at_min < ? ' +
        'GROUP BY experiment_id ORDER BY experiment_id',
    )
    .all(from, to) as unknown as {
    experiment_id: string;
    open_accounts: number;
    open_visits: number;
    interacted_visits: number;
    opens: number;
    resets: number;
    fullscreens: number;
    errors: number;
    content_versions: string | null;
  }[];

  return rows.map((row) => ({
    experimentId: row.experiment_id,
    openAccounts: Number(row.open_accounts),
    openVisits: Number(row.open_visits),
    interactedVisits: Number(row.interacted_visits),
    opens: Number(row.opens),
    resets: Number(row.resets),
    fullscreens: Number(row.fullscreens),
    errors: Number(row.errors),
    contentVersions: row.content_versions ?? '',
  }));
}

export function funnelCounts(
  db: DatabaseSync,
  experimentId: string,
  from: number,
  to: number,
): Record<string, number> {
  const rows = db
    .prepare(
      'SELECT event_type, COUNT(*) AS total FROM event ' +
        'WHERE experiment_id = ? AND occurred_at_min >= ? AND occurred_at_min < ? ' +
        'GROUP BY event_type',
    )
    .all(experimentId, from, to) as unknown as { event_type: string; total: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.event_type] = Number(row.total);
  }
  return counts;
}

export function controlDistribution(
  db: DatabaseSync,
  experimentId: string,
  from: number,
  to: number,
): { controlGroup: string; events: number; accounts: number }[] {
  const rows = db
    .prepare(
      "SELECT control_group, COUNT(*) AS total, COUNT(DISTINCT account_id) AS accounts FROM event " +
        "WHERE experiment_id = ? AND event_type = 'experiment_control_used' " +
        'AND occurred_at_min >= ? AND occurred_at_min < ? ' +
        "AND control_group <> '' GROUP BY control_group ORDER BY total DESC, control_group",
    )
    .all(experimentId, from, to) as unknown as {
    control_group: string;
    total: number;
    accounts: number;
  }[];
  return rows.map((row) => ({
    controlGroup: row.control_group,
    events: Number(row.total),
    accounts: Number(row.accounts),
  }));
}

export interface TimelineRow {
  readonly occurredAtMin: number;
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly eventType: string;
  readonly controlGroup: string;
  readonly interactionBucket: string;
  readonly errorCode: string;
  readonly deviceClass: string;
}

/** Newest first, bounded by `limit` (the caller also caps the response). */
export function accountTimeline(
  db: DatabaseSync,
  accountId: string,
  from: number,
  to: number,
  limit: number,
): TimelineRow[] {
  const rows = db
    .prepare(
      'SELECT occurred_at_min, experiment_id, content_version, app_version, event_type, ' +
        'control_group, interaction_bucket, error_code, device_class FROM event ' +
        'WHERE account_id = ? AND occurred_at_min >= ? AND occurred_at_min < ? ' +
        'ORDER BY received_at DESC, id DESC LIMIT ?',
    )
    .all(accountId, from, to, limit) as unknown as {
    occurred_at_min: number;
    experiment_id: string;
    content_version: string;
    app_version: string;
    event_type: string;
    control_group: string;
    interaction_bucket: string;
    error_code: string;
    device_class: string;
  }[];
  return rows.map((row) => ({
    occurredAtMin: Number(row.occurred_at_min),
    experimentId: row.experiment_id,
    contentVersion: row.content_version,
    appVersion: row.app_version,
    eventType: row.event_type,
    controlGroup: row.control_group,
    interactionBucket: row.interaction_bucket,
    errorCode: row.error_code,
    deviceClass: row.device_class,
  }));
}

export interface ExportRow {
  readonly occurredAtMin: number;
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly locale: string;
  readonly eventType: string;
  readonly controlGroup: string;
  readonly interactionBucket: string;
  readonly errorCode: string;
  readonly deviceClass: string;
  readonly accountId: string;
}

/**
 * Export rows deliberately omit `received_at`, the user agent and any free text; the
 * report is about content and versions, not about people's devices.
 */
export function exportEvents(
  db: DatabaseSync,
  from: number,
  to: number,
  experimentId: string | null,
  limit: number,
): ExportRow[] {
  const sql =
    'SELECT occurred_at_min, experiment_id, content_version, app_version, locale, event_type, ' +
    'control_group, interaction_bucket, error_code, device_class, account_id FROM event ' +
    'WHERE occurred_at_min >= ? AND occurred_at_min < ?' +
    (experimentId === null ? '' : ' AND experiment_id = ?') +
    ' ORDER BY occurred_at_min, experiment_id, event_type LIMIT ?';
  const params = experimentId === null ? [from, to, limit] : [from, to, experimentId, limit];
  const rows = db.prepare(sql).all(...params) as unknown as {
    occurred_at_min: number;
    experiment_id: string;
    content_version: string;
    app_version: string;
    locale: string;
    event_type: string;
    control_group: string;
    interaction_bucket: string;
    error_code: string;
    device_class: string;
    account_id: string;
  }[];
  return rows.map((row) => ({
    occurredAtMin: Number(row.occurred_at_min),
    experimentId: row.experiment_id,
    contentVersion: row.content_version,
    appVersion: row.app_version,
    locale: row.locale,
    eventType: row.event_type,
    controlGroup: row.control_group,
    interactionBucket: row.interaction_bucket,
    errorCode: row.error_code,
    deviceClass: row.device_class,
    accountId: row.account_id,
  }));
}

export function countEvents(db: DatabaseSync, from: number, to: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM event WHERE occurred_at_min >= ? AND occurred_at_min < ?')
    .get(from, to) as unknown as { total: number };
  return Number(row.total);
}
