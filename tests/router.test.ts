import { describe, expect, it } from 'vitest';
import { loginHref, nextFromSearch, parseRoute, registerHref, safeNext } from '../apps/web/src/app/router';

/**
 * Route + `next` handling. `next` is attacker-controllable (it travels in the URL), so it
 * must only ever produce an in-site path — otherwise the login redirect becomes an open
 * redirect, which is a phishing primitive.
 */

describe('parseRoute', () => {
  it.each([
    ['/', 'catalog'],
    ['/about', 'about'],
    ['/login', 'login'],
    ['/register', 'register'],
  ])('maps %s to %s', (path, name) => {
    expect(parseRoute(path).name).toBe(name);
  });

  it('maps an experiment deep link to its slug', () => {
    expect(parseRoute('/experiments/math-functions')).toEqual({
      name: 'experiment',
      slug: 'math-functions',
    });
  });

  it('treats unknown and malformed paths as not found', () => {
    expect(parseRoute('/nope').name).toBe('notFound');
    expect(parseRoute('/experiments/Math_Functions').name).toBe('notFound');
  });
});

describe('safeNext', () => {
  it('accepts in-site paths, including a query string', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/experiments/math-functions?lang=zh-CN')).toBe(
      '/experiments/math-functions?lang=zh-CN',
    );
  });

  it.each([
    'https://evil.example/login',
    '//evil.example/path',
    '/\\evil.example',
    'javascript:alert(1)',
    '/path\\with\\backslash',
    '/login?next=/',
    '/register',
    '',
    null,
    undefined,
    `/${'a'.repeat(600)}`,
  ])('refuses %s', (value) => {
    expect(safeNext(value as string | null | undefined)).toBeNull();
  });
});

describe('nextFromSearch', () => {
  it('reads a valid next parameter', () => {
    expect(nextFromSearch('?lang=en&next=%2Fexperiments%2Fmath-functions')).toBe(
      '/experiments/math-functions',
    );
  });

  it('drops an off-site next parameter', () => {
    expect(nextFromSearch('?next=https%3A%2F%2Fevil.example')).toBeNull();
  });
});

describe('auth hrefs', () => {
  it('carries the locale and the next target', () => {
    expect(loginHref('zh-CN', '/experiments/math-functions')).toBe(
      '/login?lang=zh-CN&next=%2Fexperiments%2Fmath-functions',
    );
    expect(registerHref('en')).toBe('/register?lang=en');
  });
});
