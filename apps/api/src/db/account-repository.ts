import type { DatabaseSync } from 'node:sqlite';

/** Data access for `account` (schema: migrations/0001_init.sql). */

export type AccountStatus = 'active' | 'disabled';
export type AccountLoginKind = 'email' | 'phone';

export interface AccountRecord {
  readonly id: string;
  readonly loginKind: AccountLoginKind;
  readonly normalizedLogin: string;
  readonly displayHint: string;
  readonly passwordHash: string;
  readonly status: AccountStatus;
  readonly verifiedAt: number | null;
  readonly createdAt: number;
}

interface AccountRow {
  id: string;
  login_kind: string;
  normalized_login: string;
  display_hint: string;
  password_hash: string;
  status: string;
  verified_at: number | null;
  created_at: number;
}

const COLUMNS =
  'id, login_kind, normalized_login, display_hint, password_hash, status, verified_at, created_at';

export function insertAccount(db: DatabaseSync, account: AccountRecord): void {
  db.prepare(
    `INSERT INTO account (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.id,
    account.loginKind,
    account.normalizedLogin,
    account.displayHint,
    account.passwordHash,
    account.status,
    account.verifiedAt,
    account.createdAt,
  );
}

export function findAccountByLogin(
  db: DatabaseSync,
  kind: AccountLoginKind,
  normalizedLogin: string,
): AccountRecord | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM account WHERE login_kind = ? AND normalized_login = ?`)
    .get(kind, normalizedLogin) as unknown as AccountRow | undefined;
  return row === undefined ? null : toRecord(row);
}

export function findAccountById(db: DatabaseSync, id: string): AccountRecord | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM account WHERE id = ?`)
    .get(id) as unknown as AccountRow | undefined;
  return row === undefined ? null : toRecord(row);
}

export function updateAccountPasswordHash(db: DatabaseSync, id: string, passwordHash: string): void {
  db.prepare('UPDATE account SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

/**
 * True when a write violated the `(login_kind, normalized_login)` unique index. The
 * duplicate is also caught before inserting, but two concurrent registrations must not
 * surface as a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' ||
    (typeof message === 'string' && message.includes('UNIQUE constraint failed'))
  );
}

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    loginKind: row.login_kind === 'phone' ? 'phone' : 'email',
    normalizedLogin: row.normalized_login,
    displayHint: row.display_hint,
    passwordHash: row.password_hash,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}
