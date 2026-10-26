import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { api } from './support/auth-app.js';
import {
  cookieHeader,
  errorCode,
  login,
  PRODUCTION_SESSION_COOKIE,
  register,
  SESSION_COOKIE,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

interface SessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

function readSessions(databasePath: string): SessionRow[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare(
        'SELECT id, account_id, token_hash, created_at, last_seen_at, expires_at, revoked_at ' +
          'FROM session ORDER BY created_at',
      )
      .all() as unknown as SessionRow[];
  } finally {
    db.close();
  }
}

function disableAllAccounts(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("UPDATE account SET status = 'disabled'").run();
  } finally {
    db.close();
  }
}

async function readSession(server: AuthHarness, cookie: string | null) {
  return api(server.app, {
    method: 'GET',
    url: '/api/auth/session',
    headers: cookieHeader(cookie),
  });
}

describe('GET /api/auth/session', () => {
  it('answers authenticated:false for an anonymous caller instead of faking a session', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, { method: 'GET', url: '/api/auth/session' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: false });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports only a masked identity for a live session', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = created.cookie(SESSION_COOKIE);

    const response = await readSession(harness, cookie);

    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(true);
    expect(response.body.account?.displayHint).toBe('t***@example.com');
    expect(response.body.account?.createdAt).toBe(harness.clock.value);
    expect(response.text).not.toContain('teacher@example.com');
    expect(response.text).not.toContain('token');
    expect(Object.keys(response.body.account ?? {})).toEqual(['displayHint', 'createdAt']);
  });

  it.each([
    ['a forged token', `${SESSION_COOKIE}=forged-token`],
    ['an empty token', `${SESSION_COOKIE}=`],
    ['an over-long token', `${SESSION_COOKIE}=${'a'.repeat(200)}`],
    ['a base64-url token of the wrong length', `${SESSION_COOKIE}=${'a'.repeat(42)}`],
    ['a non-cookie header', 'not-a-cookie'],
  ])('answers authenticated:false for %s without an error', async (_label, cookie) => {
    harness = await startAuthHarness();

    const response = await readSession(harness, cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: false });
  });

  it('does not accept a session token after logout and records the revocation', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = created.cookie(SESSION_COOKIE);

    const logout = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookieHeader(cookie),
    });

    expect(logout.status).toBe(204);
    expect(logout.headers['cache-control']).toBe('no-store');
    const cleared = logout.setCookie.join('; ');
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(cleared).toContain('Max-Age=0');

    const [session] = readSessions(harness.databasePath);
    expect(session.revoked_at).toBe(harness.clock.value);

    const replay = await readSession(harness, cookie);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ authenticated: false });

    const secondLogout = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookieHeader(cookie),
    });
    expect(secondLogout.status).toBe(401);
    expect(errorCode(secondLogout)).toBe('unauthenticated');
  });

  it('answers 401 for logout without any session', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, { method: 'POST', url: '/api/auth/logout' });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });

  it('revokes only the session that logged out', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const second = await login(harness.app, { identifier: 'teacher@example.com' });
    const firstCookie = created.cookie(SESSION_COOKIE);
    const secondCookie = second.cookie(SESSION_COOKIE);

    await api(harness.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookieHeader(firstCookie),
    });

    expect((await readSession(harness, firstCookie)).body).toEqual({ authenticated: false });
    expect((await readSession(harness, secondCookie)).body.authenticated).toBe(true);
  });
});

describe('GET /api/auth/session expiry (R-06)', () => {
  it('rejects a session past its absolute 60-day expiry', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = created.cookie(SESSION_COOKIE);

    for (let week = 0; week < 4; week += 1) {
      harness.clock.value += 13 * DAY_MS;
      expect((await readSession(harness, cookie)).body.authenticated).toBe(true);
    }

    harness.clock.value += 9 * DAY_MS;
    expect((await readSession(harness, cookie)).body).toEqual({ authenticated: false });
  });

  it('rejects a session idle for more than 14 days but keeps a 13-day-old one', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = created.cookie(SESSION_COOKIE);

    harness.clock.value += 13 * DAY_MS;
    expect((await readSession(harness, cookie)).body.authenticated).toBe(true);
    const [touched] = readSessions(harness.databasePath);
    expect(touched.last_seen_at).toBe(harness.clock.value);

    harness.clock.value += 15 * DAY_MS;
    expect((await readSession(harness, cookie)).body).toEqual({ authenticated: false });
  });

  it('does not extend the absolute expiry by activity', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = created.cookie(SESSION_COOKIE);

    for (let week = 0; week < 4; week += 1) {
      harness.clock.value += 13 * DAY_MS;
      expect((await readSession(harness, cookie)).body.authenticated).toBe(true);
    }

    const [session] = readSessions(harness.databasePath);
    expect(session.expires_at - session.created_at).toBe(60 * DAY_MS);
    expect(session.last_seen_at).toBe(harness.clock.value);
  });
});

describe('GET /api/auth/session account status', () => {
  it('stops honouring a live session as soon as the account is disabled', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = created.cookie(SESSION_COOKIE);

    expect((await readSession(harness, cookie)).body.authenticated).toBe(true);

    disableAllAccounts(harness.databasePath);

    expect((await readSession(harness, cookie)).body).toEqual({ authenticated: false });
  });
});

describe('session cookie attributes', () => {
  it('is HttpOnly, SameSite=Lax, Path=/ and not Secure over local http', async () => {
    harness = await startAuthHarness();

    const response = await register(harness.app);
    const raw = response.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw.join('; ') : String(raw);

    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\//);
    expect(header).toMatch(new RegExp(`; Max-Age=${String(60 * 24 * 60 * 60)}`));
    expect(header).not.toMatch(/; Secure/);
    expect(header).not.toMatch(/Domain=/);
    expect(header).not.toMatch(/Expires=/);
  });

  it('uses the __Host- prefix with Secure in production', async () => {
    harness = await startAuthHarness({ OEL_ENV: 'production' });

    const response = await register(harness.app);
    const raw = response.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw.join('; ') : String(raw);

    expect(response.status).toBe(201);
    expect(header).toMatch(new RegExp(`^${PRODUCTION_SESSION_COOKIE}=`));
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; Path=\//);
    expect(header).not.toMatch(/Domain=/);

    const cookie = response.cookie(PRODUCTION_SESSION_COOKIE);
    expect((await readSession(harness, cookie)).body.authenticated).toBe(true);
  });
});
