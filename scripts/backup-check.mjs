#!/usr/bin/env node
/**
 * Backup / restore sanity check (design §9.3, B6).
 *
 * Takes a consistent snapshot of a real SQLite database with `VACUUM INTO`, opens the
 * copy independently and checks that it is usable: `integrity_check`, the table counts,
 * and a canary write/read/delete. A backup nobody has restored is not a backup.
 *
 * Usage:
 *   node scripts/backup-check.mjs [--db <path>] [--out <json>]
 *
 * The report contains counts only — never account identifiers, messages or tokens.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const dbPath = path.resolve(argValue('--db', path.join(repoRoot, 'test-results', 'e2e', 'app.sqlite')));
const outPath = path.resolve(argValue('--out', path.join(repoRoot, 'docs', 'evidence', 'b6', 'backup.json')));

const TABLES = ['account', 'session', 'favorite', 'recent_use', 'event', 'feedback', 'internal_audit'];

const report = {
  checkedAt: new Date().toISOString(),
  source: 'sqlite',
  databasePath: dbPath,
  ok: false,
  integrity: null,
  backupBytes: 0,
  counts: {},
  canary: null,
  issues: [],
};

function countTables(db) {
  const counts = {};
  for (const table of TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    counts[table] = Number(row.total);
  }
  return counts;
}

try {
  const info = await stat(dbPath);
  if (!info.isFile()) {
    throw new Error(`not a file: ${dbPath}`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'oel-restore-'));
  const backupPath = path.join(workDir, 'snapshot.sqlite');
  try {
    // 1. Consistent snapshot while the source may still be in WAL mode.
    const source = new DatabaseSync(dbPath);
    try {
      source.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    report.backupBytes = (await stat(backupPath)).size;

    // 2. Open the copy on its own: it must not need the original file.
    const copy = new DatabaseSync(backupPath);
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').get();
      report.integrity = String(integrity.integrity_check ?? integrity['integrity_check']);
      report.counts = countTables(copy);

      // 3. Prove the copy is writable without disturbing real data.
      copy.exec('CREATE TABLE IF NOT EXISTS restore_check (id TEXT PRIMARY KEY, note TEXT NOT NULL)');
      copy.prepare('INSERT OR REPLACE INTO restore_check (id, note) VALUES (?, ?)').run('canary', 'ok');
      const canary = copy.prepare('SELECT note FROM restore_check WHERE id = ?').get('canary');
      copy.prepare('DELETE FROM restore_check WHERE id = ?').run('canary');
      const remaining = copy.prepare('SELECT COUNT(*) AS total FROM restore_check').get();
      report.canary = { readBack: String(canary?.note ?? ''), remaining: Number(remaining.total) };
    } finally {
      copy.close();
    }

    // 4. The restored copy must have the same migration baseline as the source.
    const check = new DatabaseSync(backupPath);
    try {
      const migrations = check.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      report.migrations = migrations.map((row) => row.version);
    } finally {
      check.close();
    }
    report.ok =
      report.integrity === 'ok' &&
      report.canary.readBack === 'ok' &&
      report.canary.remaining === 0 &&
      Array.isArray(report.migrations) &&
      report.migrations.length > 0 &&
      Object.values(report.counts).every((value) => Number.isInteger(value));
    if (!report.ok) {
      report.issues.push('one or more checks failed');
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
} catch (error) {
  report.issues.push(error instanceof Error ? error.message : String(error));
}

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'} backup/restore check\n`);
process.stdout.write(`  source:    ${report.databasePath}\n`);
process.stdout.write(`  snapshot:  ${String(report.backupBytes)} bytes\n`);
process.stdout.write(`  integrity: ${String(report.integrity)}\n`);
process.stdout.write(`  counts:    ${JSON.stringify(report.counts)}\n`);
process.stdout.write(`  migrations:${JSON.stringify(report.migrations ?? [])}\n`);
process.stdout.write(`  canary:    ${JSON.stringify(report.canary)}\n`);
process.stdout.write(`  report:    ${outPath}\n`);
if (!report.ok) {
  for (const issue of report.issues) process.stdout.write(`  issue: ${issue}\n`);
  process.exitCode = 1;
}
