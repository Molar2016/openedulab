#!/usr/bin/env node
/**
 * Smoke test against a REAL server process (not app.inject): builds nothing itself,
 * so run `npm run build && npm run build:api` first. It starts `apps/api/dist/index.js`
 * on a free port with a throwaway database, exercises the HTTP surface over a socket,
 * restarts to prove migration idempotence, and proves a tampered migration refuses to
 * start. Exits non-zero on the first failed expectation.
 *
 * Usage: node apps/api/scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const entry = path.join(repoRoot, 'apps', 'api', 'dist', 'index.js');
const staticDir = path.join(repoRoot, 'dist');
const migrationsDir = path.join(repoRoot, 'apps', 'api', 'migrations');
const expectedVersion = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;

const failures = [];
const children = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) {
    failures.push(name);
  }
  process.stdout.write(`${status} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function serverEnv({ port, databasePath, migrations }) {
  return {
    ...process.env,
    OEL_ENV: 'test',
    OEL_HOST: '127.0.0.1',
    OEL_PORT: String(port),
    OEL_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    OEL_DATABASE_PATH: databasePath,
    OEL_STATIC_DIR: staticDir,
    OEL_MIGRATIONS_DIR: migrations,
    OEL_LOG_LEVEL: 'warn',
  };
}

function startServer(env) {
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited, getStdout: () => stdout, getStderr: () => stderr };
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/healthz`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become healthy at ${baseUrl}`);
}

function countMigrations(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    const rows = db
      .prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')
      .all();
    return rows;
  } finally {
    db.close();
  }
}

async function stop(server) {
  server.child.kill();
  await server.exited;
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'oel-smoke-'));
  const databasePath = path.join(root, 'db', 'app.sqlite');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  process.stdout.write(`# B1 smoke — real process, node ${process.version}\n`);
  process.stdout.write(`# repo=${repoRoot}\n# db=${databasePath}\n# port=${port}\n\n`);

  try {
    process.stdout.write('## 1. configuration is fail-closed\n');
    const missingEnv = serverEnv({ port, databasePath, migrations: migrationsDir });
    delete missingEnv.OEL_PORT;
    delete missingEnv.OEL_DATABASE_PATH;
    const badConfig = startServer(missingEnv);
    const badConfigExit = await badConfig.exited;
    check('missing config exits non-zero', badConfigExit.code === 1, `exit=${badConfigExit.code}`);
    check(
      'missing config names every absent variable',
      badConfigExit.stderr.includes('OEL_PORT') && badConfigExit.stderr.includes('OEL_DATABASE_PATH'),
      badConfigExit.stderr.split('\n').filter((line) => line.includes('OEL_')).join(' | '),
    );
    check('missing config never starts listening', !badConfigExit.stdout.includes('listening'));

    process.stdout.write('\n## 2. start on an empty database\n');
    const first = startServer(serverEnv({ port, databasePath, migrations: migrationsDir }));
    const health = await waitForHealth(baseUrl);
    check('GET /api/healthz is 200', health.status === 'ok', JSON.stringify(health));
    check('healthz reports the package version', health.appVersion === expectedVersion, `${health.appVersion} vs ${expectedVersion}`);
    check(
      'healthz reports migration state',
      health.database?.ok === true &&
        health.database.migrations.applied === 1 &&
        health.database.migrations.latest === '0001' &&
        health.database.migrations.pending === 0,
      JSON.stringify(health.database),
    );

    process.stdout.write('\n## 3. same-origin SPA hosting\n');
    const deepLink = await fetch(`${baseUrl}/experiments/math.functions`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const deepLinkBody = await deepLink.text();
    check('deep link is 200', deepLink.status === 200, `status=${deepLink.status}`);
    check(
      'deep link serves the built index.html',
      deepLinkBody.includes('<div id="root">') && deepLinkBody.includes('src="/assets/'),
      `bytes=${deepLinkBody.length}`,
    );
    check(
      'deep link html is not cached',
      deepLink.headers.get('cache-control') === 'no-cache',
      deepLink.headers.get('cache-control') ?? 'none',
    );

    const assetPath = /src="(\/assets\/[^"]+)"/.exec(deepLinkBody)?.[1];
    const asset = await fetch(`${baseUrl}${assetPath}`);
    const assetBody = await asset.text();
    check('built asset is served', asset.status === 200, `${assetPath} ${asset.headers.get('content-type')}`);
    check('built asset is larger than 10 kB', assetBody.length > 10_000, `${assetBody.length} bytes`);

    process.stdout.write('\n## 4. private API placeholders deny anonymous callers\n');
    for (const route of ['/api/catalog', '/api/me/favorites', '/api/me/recent', '/api/experiments/math.functions']) {
      const response = await fetch(`${baseUrl}${route}`);
      const body = await response.json();
      check(
        `GET ${route} -> 401 unauthenticated`,
        response.status === 401 && body.error?.code === 'unauthenticated',
        `status=${response.status} code=${body.error?.code}`,
      );
    }
    const forged = await fetch(`${baseUrl}/api/catalog`, { headers: { cookie: 'oel_sid=forged' } });
    check('forged cookie is still 401', forged.status === 401, `status=${forged.status}`);

    const unknownApi = await fetch(`${baseUrl}/api/does-not-exist`, { headers: { accept: 'text/html' } });
    check(
      'unknown API route -> JSON 404',
      unknownApi.status === 404 && (unknownApi.headers.get('content-type') ?? '').includes('application/json'),
      `${unknownApi.status} ${unknownApi.headers.get('content-type')}`,
    );
    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
    check('missing asset -> 404 (not the SPA shell)', missingAsset.status === 404, `status=${missingAsset.status}`);

    process.stdout.write('\n## 5. database on disk\n');
    const rows = countMigrations(databasePath);
    check('schema_migrations has exactly one row', rows.length === 1, JSON.stringify(rows));
    check(
      'the row carries a sha256 checksum',
      typeof rows[0]?.checksum === 'string' && /^[0-9a-f]{64}$/.test(rows[0].checksum),
      rows[0]?.checksum.slice(0, 12) + '…',
    );

    process.stdout.write('\n## 6. restart against the same database\n');
    await stop(first);
    const second = startServer(serverEnv({ port, databasePath, migrations: migrationsDir }));
    const healthAfterRestart = await waitForHealth(baseUrl);
    check('healthz is 200 after restart', healthAfterRestart.status === 'ok');
    const rowsAfterRestart = countMigrations(databasePath);
    check('restart is idempotent (still one row)', rowsAfterRestart.length === 1, JSON.stringify(rowsAfterRestart.map((row) => row.version)));
    check(
      'restart keeps applied_at unchanged',
      rowsAfterRestart[0]?.applied_at === rows[0]?.applied_at,
      `before=${rows[0]?.applied_at} after=${rowsAfterRestart[0]?.applied_at}`,
    );
    await stop(second);

    process.stdout.write('\n## 7. a tampered migration refuses to start\n');
    const tamperedDir = path.join(root, 'migrations-tampered');
    await cp(migrationsDir, tamperedDir, { recursive: true });
    const target = path.join(tamperedDir, '0001_init.sql');
    await writeFile(target, `${await readFile(target, 'utf8')}\n-- edited after the migration was applied\n`, 'utf8');

    const tampered = startServer(serverEnv({ port, databasePath, migrations: tamperedDir }));
    const tamperedExit = await tampered.exited;
    check('tampered migration exits non-zero', tamperedExit.code === 1, `exit=${tamperedExit.code}`);
    check(
      'tampered migration reports checksum mismatch',
      /checksum|modified after it was applied/i.test(tamperedExit.stderr),
      tamperedExit.stderr.split('\n').filter(Boolean).slice(-2).join(' | '),
    );

    process.stdout.write(`\n# ${checks - failures.length}/${checks} checks passed\n`);
    if (failures.length > 0) {
      process.stdout.write(`# failed: ${failures.join('; ')}\n`);
      process.exitCode = 1;
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();
