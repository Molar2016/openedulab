import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config.js';
import { apiError } from './errors.js';

/**
 * CSRF / cross-site defence for state-changing calls (design §4.4).
 *
 * Three checks, all of which a cross-site HTML form cannot satisfy:
 * 1. `Origin` must be one of the origins this server is served from (fail-closed when
 *    the header is absent: browsers always send it on non-GET requests).
 * 2. `Sec-Fetch-Site`, when present, must be `same-origin` or `none`.
 * 3. A body, if declared at all, must be `application/json` — a form can only send
 *    urlencoded/text/multipart, so it cannot reach a JSON handler.
 *
 * No CSRF token table: this is sufficient while nothing is embedded cross-site and all
 * writes are JSON fetches. Adding a `<form>` submit or a third-party embed requires a
 * token first (recorded as an upgrade condition, not a TODO).
 */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_CONTENT_TYPE = /^application\/json\b/i;

export const CSRF_REJECTION_MESSAGE =
  'Request rejected: writes must come from this site with a JSON body.';

/** Origins allowed to issue writes. Production allows exactly the configured origin. */
export function allowedWriteOrigins(config: AppConfig): ReadonlySet<string> {
  const origins = new Set<string>([config.publicOrigin]);
  if (config.env !== 'production') {
    // Local development may be opened as 127.0.0.1 or localhost on the same port.
    origins.add(`http://127.0.0.1:${String(config.port)}`);
    origins.add(`http://localhost:${String(config.port)}`);
  }
  return origins;
}

export type CsrfGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;

export function createCsrfGuard(config: AppConfig): CsrfGuard {
  const allowed = allowedWriteOrigins(config);

  return async function csrfGuard(request, reply) {
    if (!UNSAFE_METHODS.has(request.method)) {
      return;
    }
    if (!isAllowedOrigin(request, allowed)) {
      return deny(reply);
    }
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return deny(reply);
    }
    const contentType = request.headers['content-type'];
    if (contentType !== undefined && !JSON_CONTENT_TYPE.test(contentType)) {
      return deny(reply);
    }
    return;
  };
}

function isAllowedOrigin(request: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  return typeof origin === 'string' && allowed.has(origin);
}

function deny(reply: FastifyReply): FastifyReply {
  return reply
    .code(403)
    .header('cache-control', 'no-store')
    .type('application/json; charset=utf-8')
    .send(apiError('forbidden', CSRF_REJECTION_MESSAGE));
}
