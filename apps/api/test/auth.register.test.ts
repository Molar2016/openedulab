import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  DEFAULT_PASSWORD,
  errorCode,
  register,
  SESSION_COOKIE,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

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

function readAccounts(databasePath: string): AccountRow[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare(
        'SELECT id, login_kind, normalized_login, display_hint, password_hash, status, ' +
          'verified_at, created_at FROM account ORDER BY created_at',
      )
      .all() as unknown as AccountRow[];
  } finally {
    db.close();
  }
}

describe('POST /api/auth/register (R-01)', () => {
  it('creates an email account, starts a session and never echoes the full identifier', async () => {
    harness = await startAuthHarness();

    const response = await register(harness.app, { identifier: 'Teacher@Example.com' });

    expect(response.status).toBe(201);
    expect(response.body.account?.displayHint).toBe('t***@example.com');
    expect(response.text).not.toContain('Teacher@Example.com');
    expect(response.text).not.toContain('teacher@example.com');

    const cookie = response.cookie(SESSION_COOKIE);
    expect(cookie).not.toBeNull();
    expect(response.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(response.headers['set-cookie']).toMatch(/SameSite=Lax/i);
    expect(response.headers['set-cookie']).toMatch(/Path=\//);
    expect(response.headers['cache-control']).toBe('no-store');

    const accounts = readAccounts(harness.databasePath);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      login_kind: 'email',
      normalized_login: 'teacher@example.com',
      display_hint: 't***@example.com',
      status: 'active',
      verified_at: null,
    });
    expect(accounts[0].password_hash).not.toContain(DEFAULT_PASSWORD);
  });

  it('creates a phone account and masks the middle digits', async () => {
    harness = await startAuthHarness();

    const response = await register(harness.app, {
      loginKind: 'phone',
      identifier: '+86 138-0000-1234',
    });

    expect(response.status).toBe(201);
    // The mask is built from the stored digits, which include the country code.
    expect(response.body.account?.displayHint).toBe('861****1234');
    expect(response.text).not.toContain('13800001234');

    const [account] = readAccounts(harness.databasePath);
    expect(account).toMatchObject({
      login_kind: 'phone',
      normalized_login: '+8613800001234',
      display_hint: '861****1234',
    });
  });

  it('assigns a server-generated UUIDv4 id and ignores caller-supplied account identity (R-19)', async () => {
    harness = await startAuthHarness();

    const response = await register(harness.app, {
      identifier: 'first@example.com',
      headers: {
        'x-account-id': 'attacker-supplied-id',
      },
    });

    expect(response.status).toBe(201);
    const [account] = readAccounts(harness.databasePath);
    expect(account.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(account.id).not.toBe('attacker-supplied-id');
    expect(response.text).not.toContain(account.id);
  });

  it('rejects an attempt to pick the account id, status or hash through the body', async () => {
    harness = await startAuthHarness();

    for (const extra of [
      { accountId: 'chosen-id' },
      { id: 'chosen-id' },
      { status: 'active' },
      { passwordHash: 'scrypt$1$1$1$a$b' },
    ]) {
      const response = await api(harness.app, {
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          loginKind: 'email',
          identifier: `sneaky-${Object.keys(extra)[0]}@example.com`,
          password: DEFAULT_PASSWORD,
          ...extra,
        },
      });

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('validation_failed');
    }

    expect(readAccounts(harness.databasePath)).toHaveLength(0);
  });
});

describe('POST /api/auth/register identifier uniqueness (R-02)', () => {
  it('treats an email as taken regardless of case and surrounding spaces', async () => {
    harness = await startAuthHarness();

    const first = await register(harness.app, { identifier: 'teacher@example.com' });
    const duplicate = await register(harness.app, { identifier: '  TEACHER@Example.COM  ' });

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate)).toBe('identifier_taken');
    expect(readAccounts(harness.databasePath)).toHaveLength(1);
  });

  it('treats a phone as taken regardless of separators', async () => {
    harness = await startAuthHarness();

    const first = await register(harness.app, {
      loginKind: 'phone',
      identifier: '+8613800001234',
    });
    const duplicate = await register(harness.app, {
      loginKind: 'phone',
      identifier: '+86 (138) 0000 1234',
    });

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate)).toBe('identifier_taken');
  });

  it('keeps phone and email namespaces independent', async () => {
    harness = await startAuthHarness();

    const phone = await register(harness.app, {
      loginKind: 'phone',
      identifier: '+8613800001234',
    });
    const email = await register(harness.app, { identifier: '8613800001234@example.com' });

    expect(phone.status).toBe(201);
    expect(email.status).toBe(201);
  });
});

describe('POST /api/auth/register validation', () => {
  it.each([
    ['not-an-email', 'email'],
    ['user@@example.com', 'email'],
    ['user@localhost', 'email'],
    ['user name@example.com', 'email'],
    ['', 'email'],
  ] as [string, 'email' | 'phone'][])('rejects malformed email %s with 400', async (identifier, loginKind) => {
    harness = await startAuthHarness();

    const response = await register(harness.app, { loginKind, identifier });

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it.each([
    ['12345', 'phone'],
    ['+86-138-0000-1234x', 'phone'],
    ['++8613800001234', 'phone'],
    ['', 'phone'],
  ] as [string, 'email' | 'phone'][])('rejects malformed phone %s with 400', async (identifier, loginKind) => {
    harness = await startAuthHarness();

    const response = await register(harness.app, { loginKind, identifier });

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('rejects an unsupported login kind', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/register',
      payload: { loginKind: 'username', identifier: 'someone', password: DEFAULT_PASSWORD },
    });

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it.each([
    ['too short', 'ninechars'],
    ['too long', 'p'.repeat(129)],
    ['all whitespace', '          '],
  ])('rejects a password that is %s', async (_label, password) => {
    harness = await startAuthHarness();

    const response = await register(harness.app, { password });

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
    expect(readAccounts(harness.databasePath)).toHaveLength(0);
  });

  it('allows a password with spaces and unicode punctuation', async () => {
    harness = await startAuthHarness();

    const response = await register(harness.app, { password: '密码 with spaces ✓' });

    expect(response.status).toBe(201);
  });
});

describe('POST /api/auth/register when already signed in', () => {
  it('returns 409 already_authenticated instead of creating a second account', async () => {
    harness = await startAuthHarness();
    const first = await register(harness.app, { identifier: 'owner@example.com' });
    const cookie = first.cookie(SESSION_COOKIE);

    const second = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        loginKind: 'email',
        identifier: 'other@example.com',
        password: DEFAULT_PASSWORD,
      },
      headers: cookieHeader(cookie),
    });

    expect(second.status).toBe(409);
    expect(errorCode(second)).toBe('already_authenticated');
    expect(readAccounts(harness.databasePath)).toHaveLength(1);
  });

  it('still allows registration when the presented cookie is not a real session', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        loginKind: 'email',
        identifier: 'fresh@example.com',
        password: DEFAULT_PASSWORD,
      },
      headers: { cookie: `${SESSION_COOKIE}=forged-token` },
    });

    expect(response.status).toBe(201);
  });
});
