import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/database.js';
import {
  MigrationError,
  discoverMigrations,
  getMigrationStatus,
  migrate,
} from '../src/db/migrate.js';
import { createFixture, writeMigration, type Fixture } from './helpers.js';

let fixture: Fixture | null = null;
let db: DatabaseSync | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  if (fixture) {
    await fixture.cleanup();
    fixture = null;
  }
});

async function setup(): Promise<{ f: Fixture; db: DatabaseSync }> {
  fixture = await createFixture();
  db = openDatabase(fixture.databasePath);
  return { f: fixture, db };
}

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function appliedRows(database: DatabaseSync): { version: string; checksum: string; applied_at: number }[] {
  return database
    .prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as { version: string; checksum: string; applied_at: number }[];
}

/** Runs a call and returns the MigrationError it threw. */
function migrationError(run: () => unknown): MigrationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    return error as MigrationError;
  }
  throw new Error('expected a MigrationError, but the call succeeded');
}

describe('migration runner', () => {
  it('applies numbered migrations in order and records a sha256 checksum per file', async () => {
    const { f, db: database } = await setup();
    await writeMigration(f.migrationsDir, '0002_add_second.sql', 'CREATE TABLE second (id TEXT);\n');

    const result = migrate(database, f.migrationsDir);

    expect(result.applied).toEqual(['0001', '0002']);
    expect(result.skipped).toBe(0);
    expect(tableExists(database, 'first')).toBe(true);
    expect(tableExists(database, 'second')).toBe(true);

    const rows = appliedRows(database);
    expect(rows.map((row) => row.version)).toEqual(['0001', '0002']);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.applied_at).toBeGreaterThan(0);
    }
  });

  it('is idempotent: a second run applies nothing and keeps applied_at unchanged', async () => {
    const { f, db: database } = await setup();
    migrate(database, f.migrationsDir);
    const before = appliedRows(database);

    const second = migrate(database, f.migrationsDir);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(1);
    expect(appliedRows(database)).toEqual(before);
  });

  it('refuses to run when an already-applied migration file was modified', async () => {
    const { f, db: database } = await setup();
    migrate(database, f.migrationsDir);
    const before = appliedRows(database);

    const file = path.join(f.migrationsDir, '0001_init.sql');
    await writeFile(file, 'CREATE TABLE first (id TEXT PRIMARY KEY);\n-- edited after apply\n', 'utf8');

    const error = migrationError(() => migrate(database, f.migrationsDir));
    expect(error.code).toBe('checksum_mismatch');
    expect(error.message).toContain('0001');
    expect(appliedRows(database)).toEqual(before);
  });

  it('rolls a failing migration back completely and can recover after the file is fixed', async () => {
    const { f, db: database } = await setup();
    await writeMigration(
      f.migrationsDir,
      '0002_broken.sql',
      'CREATE TABLE half_done (id TEXT);\nINSERT INTO no_such_table (id) VALUES (1);\n',
    );

    const error = migrationError(() => migrate(database, f.migrationsDir));
    expect(error.code).toBe('failed');
    expect(error.message).toContain('0002');
    expect(tableExists(database, 'first')).toBe(true);
    expect(tableExists(database, 'half_done')).toBe(false);
    expect(appliedRows(database).map((row) => row.version)).toEqual(['0001']);

    await writeMigration(f.migrationsDir, '0002_broken.sql', 'CREATE TABLE second (id TEXT);\n');
    const recovered = migrate(database, f.migrationsDir);
    expect(recovered.applied).toEqual(['0002']);
    expect(tableExists(database, 'second')).toBe(true);
  });

  it('refuses to start when an applied migration file disappeared', async () => {
    const { f, db: database } = await setup();
    await writeMigration(f.migrationsDir, '0002_add_second.sql', 'CREATE TABLE second (id TEXT);\n');
    migrate(database, f.migrationsDir);

    await rm(path.join(f.migrationsDir, '0002_add_second.sql'));

    const error = migrationError(() => migrate(database, f.migrationsDir));
    expect(error.code).toBe('missing_file');
    expect(error.message).toContain('0002');
  });

  it('rejects two files claiming the same version', async () => {
    const { f, db: database } = await setup();
    await writeMigration(f.migrationsDir, '0001_duplicate.sql', 'CREATE TABLE dup (id TEXT);\n');

    const error = migrationError(() => migrate(database, f.migrationsDir));
    expect(error.code).toBe('duplicate_version');
  });

  it.each(['1_init.sql', '0002-add.sql', '0003_add.SQL', 'migration.sql'])(
    'rejects malformed migration filename %j',
    async (name) => {
      const { f, db: database } = await setup();
      await writeMigration(f.migrationsDir, name, 'CREATE TABLE x (id TEXT);\n');

      const error = migrationError(() => migrate(database, f.migrationsDir));
      expect(error.code).toBe('invalid_filename');
    },
  );

  it('reports pending versions added after the last run', async () => {
    const { f, db: database } = await setup();
    migrate(database, f.migrationsDir);

    const before = getMigrationStatus(database, f.migrationsDir);
    expect(before).toEqual({ applied: ['0001'], pending: [], latest: '0001' });

    await writeMigration(f.migrationsDir, '0002_add_second.sql', 'CREATE TABLE second (id TEXT);\n');
    expect(getMigrationStatus(database, f.migrationsDir)).toEqual({
      applied: ['0001'],
      pending: ['0002'],
      latest: '0001',
    });
  });

  it('discovers migrations sorted by numeric version, not lexicographically', async () => {
    const { f } = await setup();
    await writeMigration(f.migrationsDir, '0010_ten.sql', '');
    await writeMigration(f.migrationsDir, '0002_two.sql', '');

    expect(discoverMigrations(f.migrationsDir).map((m) => m.version)).toEqual([
      '0001',
      '0002',
      '0010',
    ]);
  });
});

describe('openDatabase', () => {
  it('creates missing parent directories and enables WAL, foreign keys and a busy timeout', async () => {
    const { db: database } = await setup();

    const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const busyTimeout = database.prepare('PRAGMA busy_timeout').get() as { timeout: number };

    expect(journal.journal_mode).toBe('wal');
    expect(foreignKeys.foreign_keys).toBe(1);
    expect(busyTimeout.timeout).toBe(5000);
  });
});
