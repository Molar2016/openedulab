import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

import { apiError } from './errors.js';

/**
 * Serves the built SPA from the same origin as the API (no CORS). Hashed assets are
 * immutable-ish; HTML is always revalidated so a redeploy is picked up.
 */
export async function registerSpaHosting(app: FastifyInstance, staticDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: '/',
    index: ['index.html'],
    cacheControl: false,
    // @fastify/static >=10 passes the Fastify reply (not the raw response).
    setHeaders(reply, filePath) {
      if (filePath.endsWith('.html')) {
        reply.header('cache-control', 'no-cache');
      } else {
        reply.header('cache-control', 'public, max-age=0');
      }
    },
  });
}

const ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.map',
  '.json',
  '.xml',
  '.txt',
  '.wasm',
  '.webmanifest',
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.webm',
  '.mp3',
  '.pdf',
  '.csv',
]);

/** Looks like a request for a build artefact rather than a client-side route. */
export function looksLikeAsset(pathname: string): boolean {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) {
    return false;
  }
  return ASSET_EXTENSIONS.has(pathname.slice(dot).toLowerCase());
}

/**
 * Fallback for everything no route claimed. API paths must never be answered with the
 * SPA shell (that would hide a missing endpoint behind a 200), and a missing asset must
 * stay a 404 rather than becoming HTML.
 *
 * Experiment slugs contain dots (`math.functions`), so the asset test is an explicit
 * extension allowlist instead of a "any extension" heuristic.
 *
 * Client-side deep links fall through to this handler, which serves the SPA shell. The
 * authenticated deep-link gate (302 to /login for anonymous navigations) runs earlier as
 * an `onRequest` hook — see `http/spa-gate.ts` — so by the time we get here the caller is
 * either authenticated or asking for a public page.
 */
export function registerSpaFallback(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
      return reply
        .code(404)
        .type('application/json; charset=utf-8')
        .send(apiError('not_found', `No API route matches ${request.method} ${pathname}`));
    }

    const acceptsHtml = (request.headers.accept ?? '').includes('text/html');
    const isReadMethod = request.method === 'GET' || request.method === 'HEAD';
    if (!isReadMethod || !acceptsHtml || looksLikeAsset(pathname)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    }

    reply.header('cache-control', 'no-cache');
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });
}
