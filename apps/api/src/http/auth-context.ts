import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthService, SessionContext } from '../domain/auth-service.js';
import { readCookie, type SessionCookiePolicy } from '../security/session-policy.js';
import { apiError } from './errors.js';

/**
 * The single authorization entry point (design §3.3, D6).
 *
 * `requireSession` runs as an `onRequest` hook — before body/query parsing and before any
 * handler — so a protected handler can never observe caller-controlled input while
 * unauthenticated. It resolves the cookie against the server-side session table on every
 * request (revocation, absolute expiry, idle expiry and account status are re-checked),
 * then puts the derived account context on the request.
 *
 * Nothing else may decide authorization: no path or body field carries an account id, and
 * there is no "trusted header" shortcut.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only by `requireSession`; absent on public routes. */
    account?: SessionContext;
  }
}

export interface SessionGateOptions {
  readonly service: AuthService;
  readonly cookiePolicy: SessionCookiePolicy;
}

export interface SessionGate {
  /** `onRequest` hook: 401 for anything without a live session. */
  readonly requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Non-throwing lookup, used by the HTML deep-link gate. */
  readonly resolve: (request: FastifyRequest) => SessionContext | null;
}

export const UNAUTHENTICATED_MESSAGE = 'Sign in to continue.';

export function createSessionGate(options: SessionGateOptions): SessionGate {
  const { service, cookiePolicy } = options;

  const resolve = (request: FastifyRequest): SessionContext | null =>
    service.resolve(readCookie(request.headers.cookie, cookiePolicy.name));

  return {
    resolve,
    async requireSession(request, reply) {
      const context = resolve(request);
      if (context === null) {
        // Deliberately identical for "no cookie", "expired", "revoked" and "forged":
        // the answer must not reveal whether a session value exists.
        await reply
          .code(401)
          .header('cache-control', 'no-store')
          .type('application/json; charset=utf-8')
          .send(apiError('unauthenticated', UNAUTHENTICATED_MESSAGE));
        return;
      }
      request.account = context;
      // Personal and content responses are never cached by an intermediary.
      reply.header('cache-control', 'no-store');
    },
  };
}

/**
 * Guard for handlers that must have run behind the gate. Throws instead of returning a
 * 500 body, so a wiring mistake shows up in tests rather than as a silent anonymous read.
 */
export function accountOf(request: FastifyRequest): SessionContext {
  const context = request.account;
  if (context === undefined) {
    throw new Error('route handler reached without requireSession(); this is a wiring bug');
  }
  return context;
}
