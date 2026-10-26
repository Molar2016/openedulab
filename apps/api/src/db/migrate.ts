import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export type MigrationErrorCode =
  | 'invalid_filename'
  | 'duplicate_version'
  | 'missing_file'
  | 'checksum_mismatch'
  | 'out_of_order'
  | 'failed'
  | 'unreadable';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly version: string | null;

  constructor(code: MigrationErrorCode, message: string, version: string | null = null) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.version = version;
  }
}

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly filePath: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationStatus {
  readonly applied: string[];
  readonly pending: string[];
  readonly latest: string | null;
}

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: number;
}

interface AppliedRow {
  version: string;
  checksum: string;
  applied_at: number;
}

function checksumOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Reads every `NNNN_name.sql` file, sorted by numeric version. Anything else ending
 * in `.sql` is rejected: a migration that silently never runs is worse than a crash.
 */
export function discoverMigrations(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new MigrationError(
      'unreadable',
      `Cannot read migrations directory: ${dir}`,
      null,
    );
  }

  const files: MigrationFile[] = [];
  for (const entry of entries.filter((name) => name.toLowerCase().endsWith('.sql')).sort()) {
    const match = FILE_PATTERN.exec(entry);
    if (match === null) {
      throw new MigrationError(
        'invalid_filename',
        `Invalid migration filename "${entry}" in ${dir}; expected NNNN_lower_snake.sql`,
        entry,
      );
    }
    const filePath = join(dir, entry);
    const buffer = readFileSync(filePath);
    files.push({
      version: match[1],
      name: match[2],
      filePath,
      sql: buffer.toString('utf8'),
      checksum: checksumOf(buffer),
    });
  }

  files.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new MigrationError(
        'duplicate_version',
        `Two migrations claim version ${file.version} in ${dir}`,
        file.version,
      );
    }
    seen.add(file.version);
  }

  return files;
}

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'version TEXT PRIMARY KEY, ' +
      'checksum TEXT NOT NULL, ' +
      'applied_at INTEGER NOT NULL)',
  );
}

function readAppliedRows(db: DatabaseSync): AppliedRow[] {
  return db
    .prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as unknown as AppliedRow[];
}

interface Inspection {
  readonly files: MigrationFile[];
  readonly applied: AppliedRow[];
  readonly pending: MigrationFile[];
}

/**
 * Compares the files on disk with the recorded rows. Any drift (edited file,
 * vanished file, inserted older file) is an error: the database and the code that
 * claims to describe it must match before the process is allowed to run.
 */
function inspect(db: DatabaseSync, dir: string): Inspection {
  ensureMigrationTable(db);
  const files = discoverMigrations(dir);
  const applied = readAppliedRows(db);
  const byVersion = new Map(files.map((file) => [file.version, file]));

  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (file === undefined) {
      throw new MigrationError(
        'missing_file',
        `Migration ${row.version} is recorded as applied but its file is missing from ${dir}`,
        row.version,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        'checksum_mismatch',
        `Migration ${row.version} (${file.name}) was modified after it was applied: ` +
          `recorded ${row.checksum.slice(0, 12)}…, file ${file.checksum.slice(0, 12)}…`,
        row.version,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const latestApplied = applied.length === 0 ? null : applied[applied.length - 1].version;
  const pending = files.filter((file) => !appliedVersions.has(file.version));

  for (const file of pending) {
    if (latestApplied !== null && file.version < latestApplied) {
      throw new MigrationError(
        'out_of_order',
        `Migration ${file.version} is not applied but ${latestApplied} already is; ` +
          'migrations must be applied in order',
        file.version,
      );
    }
  }

  return { files, applied, pending };
}

/**
 * Applies pending migrations in order, each inside its own transaction, and records
 * a sha256 checksum per file. Re-running with an unchanged directory is a no-op.
 */
export function migrate(
  db: DatabaseSync,
  dir: string,
  options: { now?: () => number } = {},
): MigrationResult {
  const now = options.now ?? Date.now;
  const { applied: appliedBefore, pending } = inspect(db, dir);
  const applied: string[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
  );

  for (const file of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(file.sql);
      insert.run(file.version, file.checksum, now());
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        'failed',
        `Migration ${file.version} (${file.name}) failed and was rolled back: ${reason}`,
        file.version,
      );
    }
    applied.push(file.version);
  }

  return { applied, skipped: appliedBefore.length };
}

/** Read-only view used by the health endpoint; throws when the schema drifted. */
export function getMigrationStatus(db: DatabaseSync, dir: string): MigrationStatus {
  const { applied, pending } = inspect(db, dir);
  return {
    applied: applied.map((row) => row.version),
    pending: pending.map((file) => file.version),
    latest: applied.length === 0 ? null : applied[applied.length - 1].version,
  };
}
