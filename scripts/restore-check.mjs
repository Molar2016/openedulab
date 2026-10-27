#!/usr/bin/env node
/**
 * Restore drill (design §9.3, B8).
 *
 * A backup that has never been restored is not a backup. This script does the whole
 * round trip an operator would do, and fails loudly at the step that breaks:
 *
 *   1. take (or accept) a snapshot of a live database;
 *   2. restore it by copying it into a fresh directory — not by opening the original;
 *   3. `PRAGMA integrity_check`, table counts, migration baseline, canary write/read/delete;
 *   4. boot the real built API against the restored file and require `/api/healthz` to be
 *      OK, then prove the restored database accepts a write (a registration) over HTTP.
 *
 * Step 4 is the part that makes this a drill rather than a file check: it proves the
 * restored schema is the schema the running server expects.
 *
 * Local-only: it never touches a production host, and it copies to a temporary directory.
 * Cross-machine backup replication is a deployment decision that needs server access; it is
 * explicitly out of scope here (see docs/ops/backup-restore.md).
 *
 * Usage:
 *   node scripts/restore-check.mjs --db test-results/e2e/app.sqlite [--out report.json]
 *   node scripts/restore-check.mjs --backup backups/oel-20261026T2200.sqlite
 *
 * The report contains counts and booleans only — never account identifiers or messages.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'index.js');
const PORT = 3321;
const TABLES = [
  'account',
  'session',
  'favorite',
  'recent_use',
  'saved_state',
  'placement_saved_state',
  'event',
  'feedback',
  'internal_audit',
];

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const backupArg = argValue('--backup');
const dbArg = argValue('--db', path.join(REPO_ROOT, 'test-results', 'e2e', 'app.sqlite'));
const outPath = path.resolve(argValue('--out', path.join(REPO_ROOT, 'docs', 'evidence', 'backup', 'restore.json')));
const skipServer = process.argv.includes('--no-server');

const report = {
  checkedAt: new Date().toISOString(),
  step: 'start',
  source: backupArg === undefined ? { kind: 'live', path: path.resolve(dbArg) } : { kind: 'backup', path: path.resolve(backupArg) },
  restoredBytes: 0,
  integrity: null,
  counts: {},
  migrations: [],
  canary: null,
  server: { required: !skipServer, started: false, healthz: null, writeProbe: null, detail: null },
  ok: false,
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

async function takeSnapshot(sourcePath, targetPath) {
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
}

async function waitForHealthz(deadlineMs) {
  const started = Date.now();
  let lastDetail = null;
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/healthz`, {
        headers: { accept: 'application/json' },
      });
      const body = await response.json();
      lastDetail = `${String(response.status)} ${JSON.stringify(body.database ?? {})}`;
      if (response.status === 200 && body.status === 'ok' && (body.database?.migrations?.applied ?? 0) > 0) {
        return { ok: true, body };
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, detail: lastDetail };
}

async function bootRestoredApi(restoredPath) {
  if (!(await stat(SERVER_ENTRY).then(() => true, () => false))) {
    return { ok: false, detail: 'apps/api/dist/index.js is missing — run "npm run build:api"' };
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OEL_ENV: 'test',
      OEL_HOST: '127.0.0.1',
      OEL_PORT: String(PORT),
      OEL_PUBLIC_ORIGIN: `http://127.0.0.1:${PORT}`,
      OEL_DATABASE_PATH: restoredPath,
      OEL_STATIC_DIR: path.join(REPO_ROOT, 'dist'),
      OEL_MIGRATIONS_DIR: path.join(REPO_ROOT, 'apps', 'api', 'migrations'),
      OEL_CONTENT_DIR: path.join(REPO_ROOT, 'experiments'),
      OEL_LOG_LEVEL: 'error',
    },
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const health = await waitForHealthz(30_000);
    report.server.started = true;
    if (!health.ok) {
      return { ok: false, detail: `healthz never became OK: ${String(health.detail ?? '')} ${stderr}`.trim() };
    }
    report.server.healthz = {
      status: health.body.status,
      appVersion: health.body.appVersion,
      migrations: health.body.database.migrations,
    };

    // Prove the restored file is not read-only and the schema accepts a real write path.
    const identifier = `restore-probe-${String(Date.now())}@example.invalid`;
    const registration = await fetch(`http://127.0.0.1:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${PORT}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ loginKind: 'email', identifier, password: 'restore drill password 1' }),
    });
    report.server.writeProbe = registration.status;
    if (registration.status !== 201) {
      return { ok: false, detail: `registration against the restored database answered ${String(registration.status)}` };
    }
    return { ok: true, detail: null };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

try {
  const workDir = await mkdtemp(path.join(tmpdir(), 'oel-drill-'));
  const restoredPath = path.join(workDir, 'restored.sqlite');
  try {
    report.step = 'snapshot';
    if (backupArg === undefined) {
      const info = await stat(report.source.path);
      if (!info.isFile()) throw new Error(`not a file: ${report.source.path}`);
      await takeSnapshot(report.source.path, restoredPath);
    } else {
      const info = await stat(report.source.path);
      if (!info.isFile()) throw new Error(`not a file: ${report.source.path}`);
      // A restore is a copy into place, then opening the copy.
      await copyFile(report.source.path, restoredPath);
    }
    report.restoredBytes = (await stat(restoredPath)).size;

    report.step = 'verify';
    const copy = new DatabaseSync(restoredPath);
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').get();
      report.integrity = String(integrity.integrity_check ?? integrity['integrity_check']);
      report.counts = countTables(copy);

      copy.exec('CREATE TABLE IF NOT EXISTS restore_check (id TEXT PRIMARY KEY, note TEXT NOT NULL)');
      copy.prepare('INSERT OR REPLACE INTO restore_check (id, note) VALUES (?, ?)').run('canary', 'ok');
      const canary = copy.prepare('SELECT note FROM restore_check WHERE id = ?').get('canary');
      copy.prepare('DELETE FROM restore_check WHERE id = ?').run('canary');
      const remaining = copy.prepare('SELECT COUNT(*) AS total FROM restore_check').get();
      report.canary = { readBack: String(canary?.note ?? ''), remaining: Number(remaining.total) };

      const migrations = copy.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      report.migrations = migrations.map((row) => row.version);
    } finally {
      copy.close();
    }

    const verified =
      report.integrity === 'ok' &&
      report.canary.readBack === 'ok' &&
      report.canary.remaining === 0 &&
      report.migrations.length > 0 &&
      Object.values(report.counts).every((value) => Number.isInteger(value));
    if (!verified) {
      report.issues.push('snapshot verification failed');
    }

    if (skipServer) {
      report.server.detail = 'skipped by --no-server';
      report.ok = verified;
    } else {
      report.step = 'boot';
      const booted = await bootRestoredApi(restoredPath);
      report.server.detail = booted.detail;
      report.ok = verified && booted.ok;
      if (!booted.ok) report.issues.push(booted.detail ?? 'restored API did not come up');
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
} catch (error) {
  report.issues.push(error instanceof Error ? error.message : String(error));
}

report.step = report.ok ? 'done' : report.step;

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'} restore drill (${report.step})\n`);
process.stdout.write(`  source:     ${report.source.kind} ${report.source.path}\n`);
process.stdout.write(`  restored:   ${String(report.restoredBytes)} bytes\n`);
process.stdout.write(`  integrity:  ${String(report.integrity)}\n`);
process.stdout.write(`  counts:     ${JSON.stringify(report.counts)}\n`);
process.stdout.write(`  migrations: ${JSON.stringify(report.migrations)}\n`);
process.stdout.write(`  canary:     ${JSON.stringify(report.canary)}\n`);
process.stdout.write(`  healthz:    ${JSON.stringify(report.server.healthz)}\n`);
process.stdout.write(`  writeProbe: ${String(report.server.writeProbe)}\n`);
process.stdout.write(`  report:     ${outPath}\n`);
if (!report.ok) {
  for (const issue of report.issues) process.stdout.write(`  issue: ${issue}\n`);
  process.exitCode = 1;
}
