import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  DEFAULT_PASSWORD,
  errorCode,
  register,
  SESSION_COOKIE,
  startAuthHarness,
  TEST_ORIGIN,
  type AuthHarness,
} from './support/auth-app.js';

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const CREDENTIALS = {
  loginKind: 'email',
  identifier: 'csrf@example.com',
  password: DEFAULT_PASSWORD,
};

describe('CSRF guard on auth write routes (Origin + JSON)', () => {
  it('accepts a same-origin JSON registration (baseline)', async () => {
    harness = await startAuthHarness();

    const response = await register(harness.app, { identifier: CREDENTIALS.identifier });

    expect(response.status).toBe(201);
  });

  it('rejects a write that carries no Origin header', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/register',
      payload: CREDENTIALS,
      origin: null,
    });

    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['a foreign origin', 'https://evil.example'],
    ['a look-alike origin', 'http://127.0.0.1:3210.evil.example'],
    ['a different port on the same host', 'http://127.0.0.1:9999'],
    ['a null origin', 'null'],
  ])('rejects %s', async (_label, origin) => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/register',
      payload: CREDENTIALS,
      origin,
    });

    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
  });

  it.each([
    ['urlencoded', 'application/x-www-form-urlencoded'],
    ['plain text', 'text/plain'],
    ['multipart', 'multipart/form-data; boundary=x'],
  ])('rejects a write with a %s content type', async (_label, contentType) => {
    harness = await startAuthHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: TEST_ORIGIN, 'content-type': contentType },
      payload: 'loginKind=email&identifier=x%40example.com&password=whatever1234567890',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('rejects a cross-site fetch hint even when the Origin looks right', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/register',
      payload: CREDENTIALS,
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    expect(response.status).toBe(403);
  });

  it('accepts a same-origin fetch hint', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/register',
      payload: CREDENTIALS,
      headers: { 'sec-fetch-site': 'same-origin' },
    });

    expect(response.status).toBe(201);
  });

  it('blocks a forged logout before it can revoke anything', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: CREDENTIALS.identifier });
    const cookie = created.cookie(SESSION_COOKIE);

    const forged = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookieHeader(cookie),
      origin: 'https://evil.example',
    });

    expect(forged.status).toBe(403);
    const stillValid = await api(harness.app, {
      method: 'GET',
      url: '/api/auth/session',
      headers: cookieHeader(cookie),
    });
    expect(stillValid.body.authenticated).toBe(true);

    const real = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookieHeader(cookie),
    });
    expect(real.status).toBe(204);
  });

  it('allows a body-less same-origin logout (browser fetch sends no content type)', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: CREDENTIALS.identifier });

    const response = await api(harness.app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: cookieHeader(created.cookie(SESSION_COOKIE)),
    });

    expect(response.status).toBe(204);
  });

  it('does not gate safe reads on Origin', async () => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method: 'GET',
      url: '/api/auth/session',
      origin: null,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: false });
  });
});
