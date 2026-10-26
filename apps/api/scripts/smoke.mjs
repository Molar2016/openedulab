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
import { createHash } from 'node:crypto';
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
    OEL_CONTENT_DIR: path.join(repoRoot, 'experiments'),
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

  process.stdout.write(`# B1+B2 smoke — real process, node ${process.version}\n`);
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

    process.stdout.write('\n## 3. same-origin hosting and the anonymous deep-link gate\n');
    const deepLink = await fetch(`${baseUrl}/experiments/math.functions`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    });
    check(
      'anonymous deep link is a 302 to the login page',
      deepLink.status === 302 &&
        deepLink.headers.get('location') === '/login?next=%2Fexperiments%2Fmath.functions',
      `status=${deepLink.status} location=${deepLink.headers.get('location')}`,
    );
    check(
      'the redirect does not serve the app shell',
      !(await deepLink.text()).includes('<div id="root">'),
    );

    const loginPage = await fetch(`${baseUrl}/login`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const loginBody = await loginPage.text();
    check('the public login page is 200', loginPage.status === 200, `status=${loginPage.status}`);
    check(
      'the login page serves the built index.html',
      loginBody.includes('<div id="root">') && loginBody.includes('src="/assets/'),
      `bytes=${loginBody.length}`,
    );
    check(
      'html is not cached',
      loginPage.headers.get('cache-control') === 'no-cache',
      loginPage.headers.get('cache-control') ?? 'none',
    );

    const assetPath = /src="(\/assets\/[^"]+)"/.exec(loginBody)?.[1];
    const asset = await fetch(`${baseUrl}${assetPath}`);
    const assetBody = await asset.text();
    check('built asset is served', asset.status === 200, `${assetPath} ${asset.headers.get('content-type')}`);
    check('built asset is larger than 10 kB', assetBody.length > 10_000, `${assetBody.length} bytes`);

    process.stdout.write('\n## 4. private API refuses anonymous callers (B3 gate)\n');
    for (const route of [
      '/api/catalog',
      '/api/experiments/math.functions',
      '/api/me/favorites',
      '/api/me/recent',
    ]) {
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
    const anonymousHtmlApi = await fetch(`${baseUrl}/api/catalog`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    check(
      'an API call that accepts HTML is not redirected to the login page',
      anonymousHtmlApi.status === 401 && anonymousHtmlApi.headers.get('location') === null,
      `status=${anonymousHtmlApi.status}`,
    );
    for (const [route, method] of [
      ['/api/events', 'POST'],
      ['/api/feedback', 'POST'],
      ['/api/me/saved-state/math.functions', 'GET'],
    ]) {
      const response = await fetch(`${baseUrl}${route}`, { method });
      const body = await response.json();
      check(
        `${route} is honestly absent (404, not a fake endpoint)`,
        response.status === 404 && body.error?.code === 'not_found',
        `status=${response.status} code=${body.error?.code}`,
      );
    }

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

    process.stdout.write('\n## 6. authentication over a real socket (B2)\n');
    const origin = baseUrl;
    const credentialHeaders = { origin, 'content-type': 'application/json' };
    const password = 'correct horse battery staple';

    const postJson = async (route, body, headers = {}) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { ...credentialHeaders, ...headers },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => ({}));
      const setCookie = response.headers.getSetCookie?.() ?? [];
      return { response, json, setCookie, text: JSON.stringify(json) };
    };

    const registerOnce = (identifier, headers) =>
      postJson('/api/auth/register', { loginKind: 'email', identifier, password }, headers);
    const loginOnce = (identifier, candidate = password, headers) =>
      postJson('/api/auth/login', { loginKind: 'email', identifier, password: candidate }, headers);
    const sessionWith = async (cookie) => {
      const response = await fetch(`${baseUrl}/api/auth/session`, {
        headers: cookie ? { cookie } : {},
      });
      return { status: response.status, json: await response.json() };
    };

    const registered = await registerOnce('smoke@example.com');
    const registeredCookie = (registered.setCookie[0] ?? '').split(';')[0];
    const registeredAttributes = registered.setCookie.join('; ');
    check('register returns 201', registered.response.status === 201, `status=${registered.response.status}`);
    check(
      'register issues an HttpOnly, SameSite=Lax, Path=/ cookie',
      /HttpOnly/.test(registeredAttributes) &&
        /SameSite=Lax/.test(registeredAttributes) &&
        /Path=\//.test(registeredAttributes) &&
        /^oel_sid=[A-Za-z0-9_-]{43}$/.test(registeredCookie),
      registeredCookie.slice(0, 12) + '…',
    );
    check(
      'register returns only a masked hint',
      registered.json.account?.displayHint === 's***@example.com' &&
        !registered.text.includes('smoke@example.com'),
      JSON.stringify(registered.json),
    );

    const anonymousSession = await sessionWith(null);
    check(
      'anonymous session is authenticated:false',
      anonymousSession.status === 200 && anonymousSession.json.authenticated === false,
      JSON.stringify(anonymousSession.json),
    );
    const liveSession = await sessionWith(registeredCookie);
    check(
      'registered session is authenticated:true without leaking identifiers',
      liveSession.json.authenticated === true &&
        liveSession.json.account?.displayHint === 's***@example.com' &&
        !JSON.stringify(liveSession.json).includes('smoke@example.com'),
      JSON.stringify(liveSession.json),
    );

    const duplicate = await registerOnce('SMOKE@Example.com ');
    check(
      'duplicate identifier is 409 identifier_taken after normalization',
      duplicate.response.status === 409 && duplicate.json.error?.code === 'identifier_taken',
      `status=${duplicate.response.status} code=${duplicate.json.error?.code}`,
    );

    const wrongPassword = await loginOnce('smoke@example.com', 'wrong password 12345');
    const unknownAccount = await loginOnce('nobody@example.com');
    check(
      'wrong password is 401 invalid_credentials',
      wrongPassword.response.status === 401 &&
        wrongPassword.json.error?.code === 'invalid_credentials',
      `status=${wrongPassword.response.status}`,
    );
    check(
      'unknown identifier is byte-identical to a wrong password',
      unknownAccount.response.status === 401 && unknownAccount.text === wrongPassword.text,
      `status=${unknownAccount.response.status}`,
    );
    check(
      'failed logins never set a cookie',
      wrongPassword.setCookie.length === 0 && unknownAccount.setCookie.length === 0,
    );

    const blocked = [
      ['missing Origin', await registerOnce('csrf-missing@example.com', { origin: 'MISSING' })],
      ['foreign Origin', await registerOnce('csrf-foreign@example.com', { origin: 'https://evil.example' })],
    ];
    for (const [label, attempt] of blocked) {
      check(
        `CSRF: ${label} is rejected`,
        attempt.response.status === 403 && attempt.json.error?.code === 'forbidden',
        `status=${attempt.response.status}`,
      );
    }
    const formAttempt = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'loginKind=email&identifier=smoke%40example.com&password=whatever123456',
    });
    check('CSRF: urlencoded form login is rejected', formAttempt.status === 403, `status=${formAttempt.status}`);

    const forgedSession = await sessionWith('oel_sid=forged-token');
    check(
      'forged cookie is authenticated:false',
      forgedSession.status === 200 && forgedSession.json.authenticated === false,
    );

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { origin, cookie: registeredCookie },
    });
    check('logout returns 204', logout.status === 204, `status=${logout.status}`);
    check(
      'logout clears the cookie',
      (logout.headers.getSetCookie?.() ?? []).join('; ').includes('Max-Age=0'),
    );
    const replay = await sessionWith(registeredCookie);
    check('replaying the logged-out cookie is unauthenticated', replay.json.authenticated === false);
    const secondLogout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { origin, cookie: registeredCookie },
    });
    check('second logout is 401', secondLogout.status === 401, `status=${secondLogout.status}`);

    const freshLogin = await loginOnce('smoke@example.com');
    const liveCookie = (freshLogin.setCookie[0] ?? '').split(';')[0];
    check('login with the right password is 200', freshLogin.response.status === 200);
    check('login issues a new token', liveCookie !== registeredCookie, liveCookie.slice(0, 12) + '…');
    check(
      'the new session is authenticated',
      (await sessionWith(liveCookie)).json.authenticated === true,
    );

    process.stdout.write('\n## 6b. authenticated access to protected resources (B3)\n');
    const authed = (route) => fetch(`${baseUrl}${route}`, { headers: { cookie: liveCookie } });
    const catalogResponse = await authed('/api/catalog?locale=en');
    const catalogBody = await catalogResponse.json();
    check(
      'catalog is 200 with a live session',
      catalogResponse.status === 200,
      `status=${catalogResponse.status}`,
    );
    check(
      'catalog lists the shipped experiment with a content version',
      Array.isArray(catalogBody.items) &&
        catalogBody.items.some(
          (item) => item.id === 'math.functions' && /^\d+\.\d+\.\d+$/.test(item.contentVersion),
        ),
      JSON.stringify(catalogBody.items?.map((item) => `${item.id}@${item.contentVersion}`)),
    );
    check(
      'catalog response is not cached',
      catalogResponse.headers.get('cache-control') === 'no-store',
      catalogResponse.headers.get('cache-control') ?? 'none',
    );

    const detailResponse = await authed('/api/experiments/math.functions?locale=zh-CN');
    const detailBody = await detailResponse.json();
    check('experiment detail is 200', detailResponse.status === 200, `status=${detailResponse.status}`);
    check(
      'experiment detail carries localized title, contentVersion and sdk range',
      typeof detailBody.title === 'string' &&
        detailBody.title.length > 0 &&
        typeof detailBody.contentVersion === 'string' &&
        /^\^1\./.test(detailBody.sdkVersionRange),
      `${detailBody.title} ${detailBody.contentVersion} ${detailBody.sdkVersionRange}`,
    );
    check(
      'experiment detail exposes no filesystem path',
      !JSON.stringify(detailBody).includes('manifest.json'),
    );
    const unknownExperiment = await authed('/api/experiments/physics.nope');
    check('unknown experiment id is 404', unknownExperiment.status === 404, `status=${unknownExperiment.status}`);
    const authedDeepLink = await fetch(`${baseUrl}/experiments/math.functions`, {
      headers: { accept: 'text/html', cookie: liveCookie },
    });
    check(
      'an authenticated deep link serves the app shell',
      authedDeepLink.status === 200 && (await authedDeepLink.text()).includes('<div id="root">'),
      `status=${authedDeepLink.status}`,
    );

    process.stdout.write('\n## 6c. personal data: favorites and recent use (B4)\n');
    const putJson = async (route, body, headers = {}) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'PUT',
        headers: { origin, 'content-type': 'application/json', cookie: liveCookie, ...headers },
        body: JSON.stringify(body ?? {}),
      });
      return { status: response.status, json: await response.json().catch(() => ({})) };
    };
    const postJsonAuthed = async (route, body) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie: liveCookie },
        body: JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => ({})) };
    };

    const favoriteFirst = await putJson('/api/me/favorites/math.functions');
    check('PUT favorite -> 201', favoriteFirst.status === 201, `status=${favoriteFirst.status}`);
    const favoriteAgain = await putJson('/api/me/favorites/math.functions');
    check(
      'PUT the same favorite again -> 200 with the original timestamp',
      favoriteAgain.status === 200 && favoriteAgain.json.createdAt === favoriteFirst.json.createdAt,
      `${favoriteAgain.status} ${favoriteAgain.json.createdAt}`,
    );
    const favoriteUnknown = await putJson('/api/me/favorites/physics.nope');
    check(
      'PUT an unpublished experiment -> 404',
      favoriteUnknown.status === 404,
      `status=${favoriteUnknown.status}`,
    );

    const favoritesList = await authed('/api/me/favorites');
    const favoritesBody = await favoritesList.json();
    check(
      'GET favorites -> only id + timestamp, no parameters',
      favoritesList.status === 200 &&
        favoritesBody.items.length === 1 &&
        JSON.stringify(favoritesBody).match(/^\{.*\}$/) !== null &&
        Object.keys(favoritesBody.items[0]).sort().join(',') === 'createdAt,experimentId',
      JSON.stringify(favoritesBody.items),
    );

    check('POST recent -> 204', (await postJsonAuthed('/api/me/recent', { experimentId: 'math.functions' })).status === 204);
    check('POST recent again -> 204 (deduplicated)', (await postJsonAuthed('/api/me/recent', { experimentId: 'math.functions' })).status === 204);
    const recentList = await authed('/api/me/recent');
    const recentBody = await recentList.json();
    check(
      'GET recent -> one row per resource, no slider values',
      recentList.status === 200 &&
        recentBody.items.length === 1 &&
        Object.keys(recentBody.items[0]).sort().join(',') === 'experimentId,lastOpenedAt',
      JSON.stringify(recentBody.items),
    );

    // A second account must not see the first account's favorites.
    const secondAccount = await registerOnce('smoke-second@example.com');
    const secondCookie = (secondAccount.setCookie[0] ?? '').split(';')[0];
    const secondFavorites = await fetch(`${baseUrl}/api/me/favorites`, {
      headers: { cookie: secondCookie },
    });
    const secondBody = await secondFavorites.json();
    check(
      'another account sees an empty favorites list',
      secondFavorites.status === 200 && secondBody.items.length === 0,
      JSON.stringify(secondBody),
    );
    const secondRemoval = await fetch(`${baseUrl}/api/me/favorites/math.functions`, {
      method: 'DELETE',
      headers: { origin, cookie: secondCookie },
    });
    check('another account deleting "the same" favorite is a no-op 204', secondRemoval.status === 204);
    const favoritesStillThere = await (await authed('/api/me/favorites')).json();
    check(
      'the first account still has its favorite after that',
      favoritesStillThere.items.length === 1,
      JSON.stringify(favoritesStillThere.items),
    );

    const deleteFavorite = await fetch(`${baseUrl}/api/me/favorites/math.functions`, {
      method: 'DELETE',
      headers: { origin, cookie: liveCookie },
    });
    check('DELETE favorite -> 204', deleteFavorite.status === 204, `status=${deleteFavorite.status}`);
    const deleteAgain = await fetch(`${baseUrl}/api/me/favorites/math.functions`, {
      method: 'DELETE',
      headers: { origin, cookie: liveCookie },
    });
    check('DELETE again -> 204 (idempotent)', deleteAgain.status === 204);
    check(
      'favorites list is empty afterwards',
      (await (await authed('/api/me/favorites')).json()).items.length === 0,
    );

    const authRows = (databasePath) => {
      const db = new DatabaseSync(databasePath);
      try {
        return {
          account: db
            .prepare('SELECT login_kind, normalized_login, display_hint, password_hash, status FROM account')
            .all(),
          session: db.prepare('SELECT token_hash, revoked_at FROM session').all(),
        };
      } finally {
        db.close();
      }
    };
    const stored = authRows(databasePath);
    check(
      'database stores a scrypt hash, never the password',
      stored.account.length === 2 &&
        stored.account.every((row) => /^scrypt\$32768\$8\$3\$/.test(row.password_hash)) &&
        stored.account.every((row) => !String(row.password_hash).includes(password)),
      String(stored.account[0]?.password_hash).slice(0, 24) + '…',
    );
    check(
      'database stores sha256(token), not the token',
      stored.session.some(
        (row) =>
          row.token_hash ===
          createHash('sha256').update(liveCookie.split('=')[1]).digest('hex'),
      ),
    );

    process.stdout.write('\n## 7. registration rate limit over a real socket\n');
    let limited = null;
    let allowedRegistrations = 0;
    for (let index = 0; index < 8; index += 1) {
      const attempt = await registerOnce(`bulk-${index}@example.com`);
      if (attempt.response.status === 429) {
        limited = attempt;
        break;
      }
      allowedRegistrations += 1;
    }
    check(
      'repeated registrations from one IP hit 429',
      limited !== null && limited.json.error?.code === 'rate_limited',
      `allowed=${allowedRegistrations} status=${limited?.response.status}`,
    );
    check(
      '429 carries a numeric Retry-After',
      Number(limited?.response.headers.get('retry-after')) >= 1,
      limited?.response.headers.get('retry-after') ?? 'none',
    );

    process.stdout.write('\n## 8. restart against the same database\n');
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
    const sessionAfterRestart = await sessionWith(liveCookie);
    check(
      'a live session survives a restart (server-side, DB-backed)',
      sessionAfterRestart.json.authenticated === true,
      JSON.stringify(sessionAfterRestart.json),
    );
    const revokedAfterRestart = await sessionWith(registeredCookie);
    check(
      'a revoked session stays revoked after a restart',
      revokedAfterRestart.json.authenticated === false,
    );
    await stop(second);

    process.stdout.write('\n## 9. a tampered migration refuses to start\n');
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
