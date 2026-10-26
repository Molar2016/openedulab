import type { FastifyInstance } from 'fastify';

/**
 * Declared API surface (design §3.2/§3.3).
 *
 * Every route the server mounts under `/api` must appear here, either as *public*
 * (credentials, health) or as *session-gated* (everything holding user data or content
 * metadata). `apps/api/test/private-routes.test.ts` compares this declaration with the
 * routes the running server actually registered, so adding an endpoint without
 * classifying it fails the suite instead of quietly shipping as public.
 *
 * The lists are additive: a route may be moved from private to public only by editing
 * this file, which makes the change visible in review.
 */

export interface RouteEntry {
  readonly method: string;
  readonly url: string;
}

/** Reachable without a session. Signing in is what creates a session. */
export const PUBLIC_API_ROUTES: readonly RouteEntry[] = Object.freeze([
  { method: 'GET', url: '/api/healthz' },
  { method: 'POST', url: '/api/auth/register' },
  { method: 'POST', url: '/api/auth/login' },
  { method: 'POST', url: '/api/auth/logout' },
  { method: 'GET', url: '/api/auth/session' },
]);

/** Requires `requireSession()`; anonymous and forged callers get 401. */
export const PRIVATE_API_ROUTES: readonly RouteEntry[] = Object.freeze([
  { method: 'GET', url: '/api/catalog' },
  { method: 'GET', url: '/api/experiments/:experimentId' },
  { method: 'GET', url: '/api/me/favorites' },
  { method: 'PUT', url: '/api/me/favorites/:experimentId' },
  { method: 'DELETE', url: '/api/me/favorites/:experimentId' },
  { method: 'GET', url: '/api/me/recent' },
  { method: 'POST', url: '/api/me/recent' },
]);

function sameRoute(entry: RouteEntry, candidate: RouteEntry): boolean {
  return entry.method === candidate.method && entry.url === candidate.url;
}

export function isPublicApiRoute(entry: RouteEntry): boolean {
  return PUBLIC_API_ROUTES.some((declared) => sameRoute(declared, entry));
}

export function isPrivateApiRoute(entry: RouteEntry): boolean {
  return PRIVATE_API_ROUTES.some((declared) => sameRoute(declared, entry));
}

export interface RouteCollector {
  /** Pass to `app.addHook('onRoute', collector.record)`. */
  readonly record: (route: { method: string | string[]; url: string }) => void;
  readonly entries: readonly RouteEntry[];
}

/**
 * Records the real route table. HEAD is folded into GET because Fastify always mounts
 * both for a GET route; the inventory then matches the declaration one-for-one.
 */
export function createRouteCollector(): RouteCollector {
  const entries: RouteEntry[] = [];
  const seen = new Set<string>();

  return {
    record(route) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const raw of methods) {
        const method = raw === 'HEAD' ? 'GET' : raw;
        if (method === 'OPTIONS') continue;
        const key = `${method} ${route.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(Object.freeze({ method, url: route.url }));
      }
    },
    entries,
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Installed by `buildApp`; used by the route-inventory test. */
    readonly routeInventory: readonly RouteEntry[];
  }
}

/** Decorates the instance with the collected route table (call after registration). */
export function exposeRouteInventory(app: FastifyInstance, entries: readonly RouteEntry[]): void {
  app.decorate('routeInventory', Object.freeze([...entries]));
}
