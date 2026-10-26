import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/security/password.js';
import {
  api,
  cookieHeader,
  DEFAULT_PASSWORD,
  login,
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
  password_hash: string;
  normalized_login: string;
}

interface SessionRow {
  id: string;
  account_id: string;
  token_hash: string;
}

function readAccounts(databasePath: string): AccountRow[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare('SELECT id, password_hash, normalized_login FROM account')
      .all() as unknown as AccountRow[];
  } finally {
    db.close();
  }
}

function readSessions(databasePath: string): SessionRow[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare('SELECT id, account_id, token_hash FROM session').all() as unknown as SessionRow[];
  } finally {
    db.close();
  }
}

function run(databasePath: string, sql: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe('password storage (R-19)', () => {
  it('stores a self-describing scrypt hash and never the plaintext', async () => {
    harness = await startAuthHarness();

    await register(harness.app, { identifier: 'teacher@example.com' });

    const [account] = readAccounts(harness.databasePath);
    expect(account.password_hash).toMatch(
      /^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/,
    );
    expect(account.password_hash).not.toContain(DEFAULT_PASSWORD);
    expect(account.password_hash).not.toContain('correct horse');
  });

  it('verifies a stored hash with timingSafeEqual semantics and rejects corrupted input', async () => {
    const hash = await hashPassword(DEFAULT_PASSWORD);

    expect(await verifyPassword(hash, DEFAULT_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, `${DEFAULT_PASSWORD} `)).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);

    const [, n, r, p, salt, digest] = hash.split('$');
    expect(await verifyPassword(`scrypt$${n}$${r}$${p}$${salt}$`, 'x')).toBe(false);
    expect(await verifyPassword(`scrypt$${n}$${r}$${p}$${salt}$${digest!.slice(0, 8)}`, DEFAULT_PASSWORD)).toBe(
      false,
    );
    expect(await verifyPassword(`bcrypt$1$2$3$a$b`, DEFAULT_PASSWORD)).toBe(false);
    expect(await verifyPassword('not-a-hash', DEFAULT_PASSWORD)).toBe(false);
    // An absurd stored work factor must be refused rather than executed.
    expect(
      await verifyPassword(
        `scrypt$1073741824$8$3$${salt}$${digest}`,
        DEFAULT_PASSWORD,
      ),
    ).toBe(false);
  });

  it('upgrades the work factor on the next successful login', async () => {
    harness = await startAuthHarness();
    const legacyHash = await hashPassword(DEFAULT_PASSWORD, { N: 16384, r: 8, p: 1 });
    expect(legacyHash.startsWith('scrypt$16384$8$1$')).toBe(true);

    run(
      harness.databasePath,
      'INSERT INTO account (id, login_kind, normalized_login, display_hint, password_hash, status, ' +
        'verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'legacy-account-id',
      'email',
      'legacy@example.com',
      'l***@example.com',
      legacyHash,
      'active',
      null,
      harness.clock.value,
    );

    const response = await login(harness.app, { identifier: 'legacy@example.com' });
    expect(response.status).toBe(200);

    const [account] = readAccounts(harness.databasePath);
    expect(account.password_hash.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect(await verifyPassword(account.password_hash, DEFAULT_PASSWORD)).toBe(true);
  });
});

describe('session token storage (R-19)', () => {
  it('stores only sha256(token) and keeps the raw token out of the database', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const cookie = created.cookie(SESSION_COOKIE);
    const token = cookie?.split('=')[1] ?? '';

    const [session] = readSessions(harness.databasePath);
    expect(session.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(session.token_hash).not.toBe(token);
    expect(JSON.stringify(session)).not.toContain(token);
  });

  it('does not leak the account id, token or password into auth responses', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const [account] = readAccounts(harness.databasePath);
    const token = created.cookie(SESSION_COOKIE)?.split('=')[1] ?? '';

    const loggedIn = await login(harness.app, { identifier: 'teacher@example.com' });
    const session = await api(harness.app, {
      method: 'GET',
      url: '/api/auth/session',
      headers: cookieHeader(created.cookie(SESSION_COOKIE)),
    });

    for (const response of [created, loggedIn, session]) {
      expect(response.text).not.toContain(account.id);
      expect(response.text).not.toContain(token);
      expect(response.text).not.toContain(DEFAULT_PASSWORD);
      expect(response.text).not.toContain(account.password_hash);
      expect(response.text).not.toContain('teacher@example.com');
    }
  });
});

describe('caller-supplied identity is never trusted', () => {
  it('ignores an account_id smuggled through a query string', async () => {
    harness = await startAuthHarness();
    const owner = await register(harness.app, { identifier: 'owner@example.com' });
    const [ownerAccount] = readAccounts(harness.databasePath);

    const response = await api(harness.app, {
      method: 'GET',
      url: `/api/auth/session?account_id=${ownerAccount.id}`,
      headers: cookieHeader(owner.cookie(SESSION_COOKIE)),
    });

    expect(response.status).toBe(200);
    expect(response.body.account?.displayHint).toBe('o***@example.com');
  });

  it('does not let a login body choose which account is signed in', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'owner@example.com' });
    await register(harness.app, { identifier: 'other@example.com' });
    const accounts = readAccounts(harness.databasePath);
    const other = accounts.find((account) => account.normalized_login === 'other@example.com');
    expect(other).toBeDefined();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        loginKind: 'email',
        identifier: 'owner@example.com',
        password: DEFAULT_PASSWORD,
        accountId: other?.id,
      },
    });

    expect(response.status).toBe(400);
  });
});
