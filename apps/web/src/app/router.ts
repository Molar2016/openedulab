/** Minimal history-API router (no dependency). The server serves index.html for these paths. */

export type Route =
  | { name: 'catalog' }
  | { name: 'experiment'; slug: string }
  | { name: 'about' }
  | { name: 'login' }
  | { name: 'register' }
  | { name: 'me' }
  | { name: 'notFound'; path: string };

export function parseRoute(pathname: string): Route {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/') return { name: 'catalog' };
  if (clean === '/about') return { name: 'about' };
  if (clean === '/login') return { name: 'login' };
  if (clean === '/register') return { name: 'register' };
  if (clean === '/me') return { name: 'me' };
  const experiment = /^\/experiments\/([a-z0-9-]+)$/.exec(clean);
  if (experiment) return { name: 'experiment', slug: experiment[1] };
  return { name: 'notFound', path: clean };
}

export function catalogHref(locale: string): string {
  return `/?lang=${locale}`;
}

export function experimentHref(slug: string, locale: string): string {
  return `/experiments/${slug}?lang=${locale}`;
}

export function aboutHref(locale: string): string {
  return `/about?lang=${locale}`;
}

export function meHref(locale: string): string {
  return `/me?lang=${locale}`;
}

export function loginHref(locale: string, next?: string | null): string {
  const params = new URLSearchParams({ lang: locale });
  if (next !== undefined && next !== null && next !== '') params.set('next', next);
  return `/login?${params.toString()}`;
}

export function registerHref(locale: string, next?: string | null): string {
  const params = new URLSearchParams({ lang: locale });
  if (next !== undefined && next !== null && next !== '') params.set('next', next);
  return `/register?${params.toString()}`;
}

/**
 * Only an in-site absolute path may be used as a post-login target. Anything else
 * (absolute URLs, protocol-relative `//host`, backslashes, control characters) is
 * refused, so `next` cannot be turned into an open redirect.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value.includes('\\') || value.includes('\u0000')) return null;
  if (value.length > 512) return null;
  if (/^\/(login|register)(\?|$)/.test(value)) return null;
  return value;
}

export function nextFromSearch(search: string): string | null {
  return safeNext(new URLSearchParams(search).get('next'));
}
