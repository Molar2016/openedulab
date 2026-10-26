/** Minimal history-API router (no dependency). Static hosts need an index.html fallback. */

export type Route =
  | { name: 'catalog' }
  | { name: 'experiment'; slug: string }
  | { name: 'about' }
  | { name: 'notFound'; path: string };

export function parseRoute(pathname: string): Route {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/') return { name: 'catalog' };
  if (clean === '/about') return { name: 'about' };
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
