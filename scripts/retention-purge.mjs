#!/usr/bin/env node
/**
 * Retention purge CLI (design §9.4, B8).
 *
 * Deliberately a CLI, not an HTTP route: deletion is a maintenance act performed by
 * whoever can already open the database file. There is no `/api/internal/retention/*`
 * endpoint, and adding one is a decision that needs its own review.
 *
 * Safety rules, in order:
 * 1. The database path must exist and must not be `:memory:`.
 * 2. The default mode is a dry run: it prints what would be deleted and changes nothing.
 * 3. `--apply` additionally requires `--confirm-database <same path>`, so a wrong or
 *    copy-pasted `--db` cannot silently delete the wrong data set. Nothing is deleted
 *    unless the two paths resolve to the same file.
 * 4. Deletion itself is one transaction (see domain/retention.ts), so it is all-or-nothing
 *    and re-running it is a no-op for rows already gone.
 *
 * The report contains counts and cutoffs only — never account ids, feedback text or tokens.
 *
 * Usage:
 *   node scripts/retention-purge.mjs --db apps/api/data/local.sqlite
 *   node scripts/retention-purge.mjs --db apps/api/data/local.sqlite \
 *     --apply --confirm-database apps/api/data/local.sqlite [--out retention.json]
 *
 * Requires `npm run build:api` first: the SQL that runs here is the compiled module the
 * tests cover, not a second copy of the rules.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const USAGE = `Usage: node scripts/retention-purge.mjs --db <path> [--apply --confirm-database <path>] [--now <ms|ISO>] [--out <json>]

  --db <path>              SQLite database to clean (required; :memory: is refused)
  --apply                  delete rows past their retention window (default: dry run)
  --confirm-database <p>   required with --apply; must resolve to the same file as --db
  --now <ms|ISO>           override the clock (reproducible reports and tests)
  --out <json>             also write the JSON report to this path`;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message, code = 2) {
  process.stderr.write(`retention-purge: ${message}\n`);
  process.exit(code);
}

/**
 * The guard that stands between a typo and deleted data. Exported shape kept trivial so a
 * test can call it: returns the resolved path or throws with a message that says what to do.
 */
export function assertApplyConfirmation(dbPath, confirmValue) {
  if (confirmValue === undefined) {
    throw new Error('--apply requires --confirm-database <path> naming the same database');
  }
  const resolved = path.resolve(dbPath);
  const confirmed = path.resolve(confirmValue);
  if (resolved !== confirmed) {
    throw new Error(`--confirm-database does not match --db (${confirmed} != ${resolved})`);
  }
  return resolved;
}

function parseNow(raw) {
  if (raw === undefined) {
    return Date.now();
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`--now must be epoch milliseconds or an ISO timestamp: ${raw}`);
  }
  return parsed;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dbArg = argValue('--db');
  if (dbArg === undefined || dbArg.trim() === '') {
    fail(`--db is required\n${USAGE}`);
  }
  if (dbArg === ':memory:') {
    fail('refusing :memory:: a purge there would be a no-op that looks like success');
  }
  const dbPath = path.resolve(dbArg);
  if (!existsSync(dbPath)) {
    fail(`database not found: ${dbPath}`);
  }

  const apply = process.argv.includes('--apply');
  const now = parseNow(argValue('--now'));
  let confirmedPath;
  if (apply) {
    try {
      confirmedPath = assertApplyConfirmation(dbPath, argValue('--confirm-database'));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  const moduleUrl = pathToFileURL(
    path.join(REPO_ROOT, 'apps', 'api', 'dist', 'domain', 'retention.js'),
  ).href;
  let retention;
  try {
    retention = await import(moduleUrl);
  } catch {
    fail('apps/api/dist/domain/retention.js is missing — run "npm run build:api" first');
  }

  const db = new DatabaseSync(dbPath);
  let report;
  try {
    report = apply ? retention.purgeRetention(db, now) : retention.planRetention(db, now);
  } finally {
    db.close();
  }

  const target = apply ? confirmedPath : dbPath;
  const lines = [
    `retention ${report.mode} on ${target}`,
    `  generatedAt: ${new Date(report.generatedAt).toISOString()}`,
  ];
  for (const rule of report.rules) {
    const cutoff = new Date(rule.cutoff).toISOString();
    const verb = apply ? 'deleted' : 'would delete';
    lines.push(
      `  ${rule.table.padEnd(15)} ${verb} ${String(rule.plannedRows).padStart(7)} rows ` +
        `(older than ${String(rule.maxAgeDays)}d, cutoff ${cutoff})`,
    );
  }
  lines.push(`  total: ${apply ? 'deleted' : 'would delete'} ${String(report.totalPlanned)} rows`);
  process.stdout.write(`${lines.join('\n')}\n`);

  const outPath = argValue('--out');
  if (outPath !== undefined) {
    const resolved = path.resolve(outPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify({ ...report, databasePath: target }, null, 2)}\n`, 'utf8');
    process.stdout.write(`  report: ${resolved}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`retention-purge failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
