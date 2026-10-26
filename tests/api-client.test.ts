import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../apps/web/src/services/api';

/**
 * API client contract: one request builder, no token handling, typed failures.
 * These tests exist because the client is the only place the browser talks to the
 * server, and a silent change here (dropping `credentials`, sending a body as a form,
 * swallowing an error) would quietly weaken every screen.
 */

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: typeof fetch) {
  return createApiClient({ fetchImpl });
}

describe('api client requests', () => {
  it('always sends same-origin credentials and asks for JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ authenticated: false }));
    await client(fetchImpl as unknown as typeof fetch).session();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/session');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('posts credentials as JSON, never as a form and never in the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ account: { displayHint: 't***@e.com' } }, 201));
    const result = await client(fetchImpl as unknown as typeof fetch).register({
      loginKind: 'email',
      identifier: 'teacher@example.com',
      password: 'correct horse battery staple',
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/register');
    expect(url).not.toContain('password');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      loginKind: 'email',
      identifier: 'teacher@example.com',
      password: 'correct horse battery staple',
    });
    expect(result.displayHint).toBe('t***@e.com');
  });

  it('passes catalog filters as query parameters and returns the items', async () => {
    const items = [{ id: 'math.functions', title: 'Functions' }];
    const fetchImpl = vi.fn(async () => jsonResponse({ items }));
    const result = await client(fetchImpl as unknown as typeof fetch).catalog({
      subject: 'math',
      locale: 'zh-CN',
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('/api/catalog?subject=math&locale=zh-CN');
    expect(result).toEqual(items);
  });

  it('encodes the experiment id instead of pasting raw path text', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'math.functions' }));
    await client(fetchImpl as unknown as typeof fetch).experiment('../etc/passwd');

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('/api/experiments/..%2Fetc%2Fpasswd');
  });

  it('treats 204 as success with no body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(client(fetchImpl as unknown as typeof fetch).logout()).resolves.toBeUndefined();
  });
});

describe('api client failures', () => {
  it('maps the server error code and status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'invalid_credentials', message: 'no' } }, 401),
    );

    await expect(
      client(fetchImpl as unknown as typeof fetch).login({
        loginKind: 'email',
        identifier: 'a@b.co',
        password: 'xxxxxxxxxx',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials', status: 401 });
  });

  it('keeps Retry-After for a rate-limited answer', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'rate_limited' } }, 429, { 'retry-after': '120' }),
    );

    const failure = await client(fetchImpl as unknown as typeof fetch)
      .login({ loginKind: 'phone', identifier: '13800001234', password: 'xxxxxxxxxx' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).retryAfterSeconds).toBe(120);
  });

  it('reports an offline failure as a first-class code, not as success', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(
      client(fetchImpl as unknown as typeof fetch).logout(),
    ).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });

  it('does not trust an unknown error code from the server', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'something_new', message: 'x' } }, 500),
    );

    await expect(
      client(fetchImpl as unknown as typeof fetch).catalog(),
    ).rejects.toMatchObject({ code: 'server_error', status: 500 });
  });
});
