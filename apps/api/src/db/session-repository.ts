import type { DatabaseSync } from 'node:sqlite';

/** Data access for `session` (schema: migrations/0001_init.sql). */

export interface SessionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface SessionLookupRecord extends SessionRecord {
  readonly accountStatus: string;
  readonly displayHint: string;
  readonly accountCreatedAt: number;
}

interface SessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface LookupRow extends SessionRow {
  status: string;
  display_hint: string;
  account_created_at: number;
}

export function insertSession(db: DatabaseSync, session: SessionRecord): void {
  db.prepare(
    'INSERT INTO session (id, account_id, token_hash, created_at, last_seen_at, expires_at, revoked_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    session.id,
    session.accountId,
    session.tokenHash,
    session.createdAt,
    session.lastSeenAt,
    session.expiresAt,
    session.revokedAt,
  );
}

/**
 * Session plus the account facts needed for authorization, in one query so a route can
 * never authorize against a stale account row.
 */
export function findSessionByTokenHash(
  db: DatabaseSync,
  tokenHash: string,
): SessionLookupRecord | null {
  const row = db
    .prepare(
      'SELECT s.id, s.account_id, s.token_hash, s.created_at, s.last_seen_at, s.expires_at, ' +
        's.revoked_at, a.status, a.display_hint, a.created_at AS account_created_at ' +
        'FROM session s JOIN account a ON a.id = s.account_id WHERE s.token_hash = ?',
    )
    .get(tokenHash) as unknown as LookupRow | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    accountId: row.account_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    accountStatus: row.status,
    displayHint: row.display_hint,
    accountCreatedAt: row.account_created_at,
  };
}

export function touchSessionLastSeen(db: DatabaseSync, id: string, lastSeenAt: number): void {
  db.prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, id);
}

/** Returns true when a live session was revoked; false when there was nothing to revoke. */
export function revokeSessionByTokenHash(
  db: DatabaseSync,
  tokenHash: string,
  revokedAt: number,
): boolean {
  const result = db
    .prepare('UPDATE session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(revokedAt, tokenHash);
  return Number(result.changes) > 0;
}

/** Used when an account is disabled; every session of that account must stop at once. */
export function revokeSessionsForAccount(
  db: DatabaseSync,
  accountId: string,
  revokedAt: number,
): number {
  const result = db
    .prepare('UPDATE session SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL')
    .run(revokedAt, accountId);
  return Number(result.changes);
}
