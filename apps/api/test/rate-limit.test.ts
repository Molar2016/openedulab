import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  DEFAULT_PASSWORD,
  errorCode,
  login,
  register,
  startAuthHarness,
  type ApiResponse,
  type AuthHarness,
} from './support/auth-app.js';

const MINUTE_MS = 60 * 1000;

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

function expectRateLimited(response: ApiResponse): void {
  expect(response.status).toBe(429);
  expect(errorCode(response)).toBe('rate_limited');
  const retryAfter = response.headers['retry-after'];
  expect(retryAfter).toBeDefined();
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  expect(response.headers['cache-control']).toBe('no-store');
}

describe('registration rate limiting', () => {
  it('allows five registrations per IP per hour and then answers 429 with Retry-After', async () => {
    harness = await startAuthHarness();

    for (let index = 0; index < 5; index += 1) {
      const created = await register(harness.app, { identifier: `user-${index}@example.com` });
      expect(created.status).toBe(201);
    }

    const blocked = await register(harness.app, { identifier: 'user-5@example.com' });
    expectRateLimited(blocked);

    // The limit is time based: once the hour passes, registration works again.
    harness.clock.value += 61 * MINUTE_MS;
    const after = await register(harness.app, { identifier: 'user-6@example.com' });
    expect(after.status).toBe(201);
  });

  it('limits repeated attempts against one identifier separately from the IP budget', async () => {
    harness = await startAuthHarness();
    const identifier = 'target@example.com';

    const first = await register(harness.app, { identifier });
    expect(first.status).toBe(201);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const duplicate = await register(harness.app, { identifier });
      expect(duplicate.status).toBe(409);
    }

    const blocked = await register(harness.app, { identifier });
    expectRateLimited(blocked);

    // A different identifier from the same IP still has IP budget left.
    const other = await register(harness.app, { identifier: 'someone-else@example.com' });
    expect(other.status).toBe(201);
  });
});

describe('login rate limiting and lockout', () => {
  it('locks an identifier after ten failed attempts and refuses even the right password', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'target@example.com' });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await login(harness.app, {
        identifier: 'target@example.com',
        password: `wrong-password-${attempt}`,
      });
      expect(failed.status).toBe(401);
      expect(errorCode(failed)).toBe('invalid_credentials');
    }

    const locked = await login(harness.app, { identifier: 'target@example.com' });
    expectRateLimited(locked);
    // The lockout message must differ from the generic credential failure so a user
    // does not keep retrying a password that is in fact correct.
    const wrongBody = (
      await login(harness.app, {
        identifier: 'target@example.com',
        password: 'still-wrong-password',
      })
    ).body;
    expect(JSON.stringify(wrongBody)).toContain('rate_limited');

    const firstFailure = await login(harness.app, {
      identifier: 'another@example.com',
      password: 'nobody-here-1234',
    });
    expect(firstFailure.status).toBe(401);
    expect(locked.body.error?.message).not.toBe(firstFailure.body.error?.message);
  });

  it('releases the lock after the window passes', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'target@example.com' });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await login(harness.app, {
        identifier: 'target@example.com',
        password: `wrong-password-${attempt}`,
      });
    }
    expectRateLimited(await login(harness.app, { identifier: 'target@example.com' }));

    harness.clock.value += 16 * MINUTE_MS;

    const recovered = await login(harness.app, { identifier: 'target@example.com' });
    expect(recovered.status).toBe(200);
  });
});

describe('session endpoint rate limiting', () => {
  it('allows 300 session reads per minute and then answers 429', async () => {
    harness = await startAuthHarness();

    for (let index = 0; index < 300; index += 1) {
      const response = await api(harness.app, { method: 'GET', url: '/api/auth/session' });
      expect(response.status).toBe(200);
    }

    const blocked = await api(harness.app, { method: 'GET', url: '/api/auth/session' });
    expectRateLimited(blocked);

    harness.clock.value += 61 * 1000;
    const recovered = await api(harness.app, { method: 'GET', url: '/api/auth/session' });
    expect(recovered.status).toBe(200);
  });
});

describe('rate limits do not change the authentication outcome by themselves', () => {
  it('still rejects a wrong password with 401 while the failure budget is open', async () => {
    harness = await startAuthHarness();
    await register(harness.app, { identifier: 'target@example.com' });

    const response = await login(harness.app, {
      identifier: 'target@example.com',
      password: DEFAULT_PASSWORD.toUpperCase(),
    });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('invalid_credentials');
  });
});
