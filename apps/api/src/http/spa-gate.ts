import type { FastifyInstance } from 'fastify';

import type { SessionGate } from './auth-context.js';
import { looksLikeAsset } from './static.js';

/**
 * HTML deep-link gate (design §3.2, R-05).
 *
 * Browser navigations (an `Accept: text/html` GET/HEAD) are allowed through only for the
 * public pages; every other page redirects to `/login?next=…`. This is what makes
 * "未登录不能直达实验 URL" true at the transport level rather than by hiding a link
 * in JavaScript.
 *
 * Deliberate limits, so nobody mistakes it for more than it is:
 * - build artefacts stay public (JS/CSS cannot be protected by a login);
 * - the API is never answered with a redirect — it has its own 401 gate;
 * - `next` is only echoed into the login page; the client validates it before navigating,
 *   and the redirect target is always a local path.
 */

export const PUBLIC_HTML_PATHS: readonly string[] = Object.freeze(['/login', '/register', '/about']);

const LOGIN_PATH = '/login';

export interface SpaGateOptions {
  readonly gate: SessionGate;
}

function splitUrl(rawUrl: string): { pathname: string; search: string } {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) {
    return { pathname: rawUrl, search: '' };
  }
  return { pathname: rawUrl.slice(0, queryStart), search: rawUrl.slice(queryStart) };
}

export function registerSpaGate(app: FastifyInstance, options: SpaGateOptions): void {
  const { gate } = options;

  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return;
    }
    const accept = request.headers.accept ?? '';
    if (!accept.includes('text/html')) {
      return;
    }
    const { pathname, search } = splitUrl(request.raw.url ?? '/');
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return;
    }
    if (looksLikeAsset(pathname)) {
      return;
    }
    /**
     * Only plain, unencoded page paths are gated. Percent-encoded or control-character
     * paths are traversal/canary probes, and those must be answered by the static layer
     * (400/403/404) rather than converted into a redirect. The trade-off is explicit: a
     * percent-encoded navigation can reach the public app shell, which contains no
     * protected data — the API 401 and the client-side session check still apply.
     */
    if (!/^\/[A-Za-z0-9\-._~/]*$/.test(pathname)) {
      return;
    }
    const normalized = pathname.replace(/\/+$/, '') || '/';
    if (PUBLIC_HTML_PATHS.includes(normalized)) {
      return;
    }
    if (gate.resolve(request) !== null) {
      return;
    }
    reply.header('cache-control', 'no-store');
    await reply.redirect(`${LOGIN_PATH}?next=${encodeURIComponent(pathname + search)}`, 302);
  });
}
