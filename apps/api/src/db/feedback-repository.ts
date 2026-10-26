import type { DatabaseSync } from 'node:sqlite';

/**
 * Data access for `feedback` and `internal_audit` (design §5.7/§5.8).
 *
 * `feedback` is the only table holding user-written text. It is physically separate from
 * `event` so a future "delete my data" or a retention purge can treat them differently,
 * and so nobody is tempted to build usage metrics out of a complaint.
 *
 * `internal_audit` records who looked at what and why — never the content itself.
 */

export interface FeedbackRecord {
  readonly id: string;
  readonly accountId: string;
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly category: string;
  readonly message: string | null;
  readonly createdAt: number;
}

export function insertFeedback(db: DatabaseSync, record: FeedbackRecord): void {
  db.prepare(
    'INSERT INTO feedback (id, account_id, experiment_id, content_version, app_version, category, message, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    record.id,
    record.accountId,
    record.experimentId,
    record.contentVersion,
    record.appVersion,
    record.category,
    record.message,
    record.createdAt,
  );
}

export interface FeedbackExportRow {
  readonly id: string;
  readonly createdAt: number;
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly category: string;
  readonly message: string;
  readonly accountId: string;
}

export function exportFeedback(
  db: DatabaseSync,
  from: number,
  to: number,
  limit: number,
): FeedbackExportRow[] {
  const rows = db
    .prepare(
      'SELECT id, created_at, experiment_id, content_version, app_version, category, message, ' +
        'account_id FROM feedback WHERE created_at >= ? AND created_at < ? ' +
        'ORDER BY created_at LIMIT ?',
    )
    .all(from, to, limit) as unknown as {
    id: string;
    created_at: number;
    experiment_id: string;
    content_version: string;
    app_version: string;
    category: string;
    message: string | null;
    account_id: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    createdAt: Number(row.created_at),
    experimentId: row.experiment_id,
    contentVersion: row.content_version,
    appVersion: row.app_version,
    category: row.category,
    message: row.message ?? '',
    accountId: row.account_id,
  }));
}

export interface AuditRecord {
  readonly id: string;
  readonly operatorLabel: string;
  readonly action: 'overview' | 'account_timeline' | 'export_events' | 'export_feedback';
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly rowCount: number;
  readonly createdAt: number;
}

export function insertAudit(db: DatabaseSync, record: AuditRecord): void {
  db.prepare(
    'INSERT INTO internal_audit (id, operator_label, action, target_type, target_id, reason, row_count, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    record.id,
    record.operatorLabel,
    record.action,
    record.targetType,
    record.targetId,
    record.reason,
    record.rowCount,
    record.createdAt,
  );
}
