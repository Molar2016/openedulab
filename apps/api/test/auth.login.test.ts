import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  DEFAULT_PASSWORD,
  errorCode,
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

function disableAccount(databasePath: string, normalizedLogin: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    const result = db
      .prepare("UPDATE account SET status = 'disabled' WHERE normalized_login = ?")
      .run(normalizedLogin);
    if (result.changes !== 1) {
      throw new Error(`expected to disable exactly one account, changed ${String(result.changes)}`);
    }
  } finally {
    db.close();
  }
}

describe('POST /api/auth/login (R-03)', () => {
  it('accepts the right password and issues a fresh session token', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    const registrationCookie = created.cookie(SESSION_COOKIE);

    const response = await login(harness.app, { identifier: 'teacher@example.com' });

    expect(response.status).toBe(200);
    expect(response.body.account?.displayHint).toBe('t***@example.com');
    const loginCookie = response.cookie(SESSION_COOKIE);
    expect(loginCookie).not.toBeNull();
    expect(loginCookie).not.toBe(registrationCookie);
    expect(response.text).not.toContain('teacher@example.com');
  });

  it('normalizes the identifier on login too', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'teacher@example.com' });

    const response = await login(harness.app, { identifier: '  TEACHER@Example.com ' });

    expect(response.status).toBe(200);
  });

  it('answers a wrong password and an unknown identifier with the same 401 body', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'teacher@example.com' });

    const wrongPassword = await login(harness.app, {
      identifier: 'teacher@example.com',
      password: 'definitely-wrong-password',
    });
    const unknownIdentifier = await login(harness.app, {
      identifier: 'nobody@example.com',
      password: DEFAULT_PASSWORD,
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownIdentifier.status).toBe(401);
    expect(errorCode(wrongPassword)).toBe('invalid_credentials');
    expect(wrongPassword.body).toEqual(unknownIdentifier.body);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    expect(unknownIdentifier.headers['set-cookie']).toBeUndefined();
  });

  it('spends comparable work when the account does not exist (no early exit)', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'teacher@example.com' });

    const wrongStarted = Date.now();
    const wrongPassword = await login(harness.app, {
      identifier: 'teacher@example.com',
      password: 'definitely-wrong-password',
    });
    const wrongMs = Date.now() - wrongStarted;

    const unknownStarted = Date.now();
    const unknownIdentifier = await login(harness.app, {
      identifier: 'nobody@example.com',
      password: DEFAULT_PASSWORD,
    });
    const unknownMs = Date.now() - unknownStarted;

    expect(wrongPassword.status).toBe(401);
    expect(unknownIdentifier.status).toBe(401);
    // Both paths must run the scrypt work factor; an early "no such account" return
    // would be an order of magnitude faster and leak account existence.
    expect(wrongMs).toBeGreaterThanOrEqual(100);
    expect(unknownMs).toBeGreaterThanOrEqual(100);
    expect(Math.max(wrongMs, unknownMs) / Math.min(wrongMs, unknownMs)).toBeLessThan(3);
  });

  it('refuses a disabled account with the same message as a wrong password', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'teacher@example.com' });
    disableAccount(harness.databasePath, 'teacher@example.com');

    const disabled = await login(harness.app, { identifier: 'teacher@example.com' });
    const unknown = await login(harness.app, { identifier: 'nobody@example.com' });

    expect(disabled.status).toBe(401);
    expect(errorCode(disabled)).toBe('invalid_credentials');
    expect(disabled.body).toEqual(unknown.body);
    expect(disabled.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a login attempt that tries to name another account', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'teacher@example.com' });

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        loginKind: 'email',
        identifier: 'teacher@example.com',
        password: DEFAULT_PASSWORD,
        accountId: 'someone-else',
      },
    });

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('returns 409 already_authenticated when a valid session is already presented', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        loginKind: 'email',
        identifier: 'teacher@example.com',
        password: DEFAULT_PASSWORD,
      },
      headers: cookieHeader(created.cookie(SESSION_COOKIE)),
    });

    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe('already_authenticated');
  });
});

describe('POST /api/auth/login failure accounting', () => {
  it('does not lock the identifier after a correct password resets the streak', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'teacher@example.com' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await login(harness.app, {
        identifier: 'teacher@example.com',
        password: `wrong-password-${attempt}`,
      });
      expect(failed.status).toBe(401);
    }

    const success = await login(harness.app, { identifier: 'teacher@example.com' });
    expect(success.status).toBe(200);

    // The streak counter was reset by the success, so five more failures stay 401.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await login(harness.app, {
        identifier: 'teacher@example.com',
        password: `wrong-again-${attempt}`,
      });
      expect(failed.status).toBe(401);
    }
  });
});
