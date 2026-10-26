import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config.js';
import { DuplicateIdentifierError, type AuthService } from '../domain/auth-service.js';
import { normalizeIdentifier } from '../security/identifier.js';
import { validatePassword } from '../security/password.js';
import { InMemoryRateLimiter, type RateLimitRule, type RateLimitStatus } from '../security/rate-limit.js';
import {
  readCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionCookiePolicy,
  type SessionCookiePolicy,
} from '../security/session-policy.js';
import { createCsrfGuard } from './csrf.js';
import { apiError } from './errors.js';

/**
 * B2 authentication surface (design §7.1):
 *
 *   POST /api/auth/register   201 + session cookie
 *   POST /api/auth/login      200 + session cookie
 *   POST /api/auth/logout     204 + cleared cookie
 *   GET  /api/auth/session    200 {authenticated:boolean}
 *
 * What this module deliberately does NOT do: gate resources (B3), accept an account id
 * from the caller, or expose the token / raw identifier in a response body.
 */

export const AUTH_REGISTER_PATH = '/api/auth/register';
export const AUTH_LOGIN_PATH = '/api/auth/login';
export const AUTH_LOGOUT_PATH = '/api/auth/logout';
export const AUTH_SESSION_PATH = '/api/auth/session';

const JSON_TYPE = 'application/json; charset=utf-8';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Minimum wall-clock time for a login answer, to blunt timing side channels. */
const MIN_LOGIN_DURATION_MS = 150;

const RULES = {
  registerIp: { limit: 5, windowMs: HOUR_MS },
  registerIdentifier: { limit: 3, windowMs: DAY_MS },
  loginIp: { limit: 30, windowMs: 15 * MINUTE_MS },
  loginIdentifier: { limit: 10, windowMs: 15 * MINUTE_MS },
  loginFailures: { limit: 10, windowMs: 15 * MINUTE_MS },
  sessionIp: { limit: 300, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitRule>;

const CREDENTIALS_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['loginKind', 'identifier', 'password'],
  properties: {
    loginKind: { type: 'string', enum: ['email', 'phone'] },
    identifier: { type: 'string', minLength: 1, maxLength: 254 },
    password: { type: 'string', minLength: 1, maxLength: 512 },
  },
};

interface CredentialsBody {
  readonly loginKind: 'email' | 'phone';
  readonly identifier: string;
  readonly password: string;
}

const MESSAGES = {
  invalidCredentials: 'Invalid identifier or password.',
  identifierTaken: 'This identifier is already registered.',
  alreadyAuthenticated: 'You are already signed in.',
  unauthenticated: 'You are not signed in.',
  invalidIdentifier: 'Identifier is not valid.',
  invalidPassword: 'Password must be 10 to 128 characters and not blank.',
  registerIpLimited: 'Too many registrations from this network. Try again later.',
  registerIdentifierLimited: 'Too many registration attempts for this identifier. Try again later.',
  loginIpLimited: 'Too many sign-in attempts from this network. Try again later.',
  loginAttemptLimited: 'Too many sign-in attempts for this account. Try again later.',
  loginLocked: 'Too many failed sign-in attempts. Try again later.',
  sessionLimited: 'Too many requests. Try again later.',
} as const;

export interface AuthRouteOptions {
  readonly config: AppConfig;
  readonly now: () => number;
  /**
   * The same service instance the `requireSession` gate uses. Owned by `buildApp` so a
   * session created here is immediately valid everywhere, and a revocation here is
   * immediately fatal everywhere.
   */
  readonly service: AuthService;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { config, now, service } = options;
  const limiter = new InMemoryRateLimiter(now);
  const cookiePolicy = sessionCookiePolicy(config);
  const csrfGuard = createCsrfGuard(config);

  const readToken = (request: FastifyRequest): string | null =>
    readCookie(request.headers.cookie, cookiePolicy.name);

  app.post(
    AUTH_REGISTER_PATH,
    { schema: { body: CREDENTIALS_SCHEMA }, onRequest: csrfGuard },
    async (request, reply) => {
      const body = request.body as CredentialsBody;
      const identifier = normalizeIdentifier(body.loginKind, body.identifier);
      if (!identifier.ok) {
        return fail(reply, 400, 'validation_failed', MESSAGES.invalidIdentifier);
      }
      const password = validatePassword(body.password);
      if (!password.ok) {
        return fail(reply, 400, 'validation_failed', MESSAGES.invalidPassword);
      }
      if (service.resolve(readToken(request)) !== null) {
        return fail(reply, 409, 'already_authenticated', MESSAGES.alreadyAuthenticated);
      }

      const ipBudget = limiter.consume(`register:ip:${request.ip}`, RULES.registerIp);
      if (ipBudget.blocked) {
        return limited(reply, ipBudget, MESSAGES.registerIpLimited);
      }
      const identifierKey = `${identifier.value.kind}:${identifier.value.normalized}`;
      const identifierBudget = limiter.consume(
        `register:id:${identifierKey}`,
        RULES.registerIdentifier,
      );
      if (identifierBudget.blocked) {
        return limited(reply, identifierBudget, MESSAGES.registerIdentifierLimited);
      }

      try {
        const result = await service.register({
          loginKind: identifier.value.kind,
          identifier: identifier.value,
          password: password.value,
        });
        setSessionCookie(reply, cookiePolicy, result.session.token);
        return noStore(reply)
          .code(201)
          .type(JSON_TYPE)
          .send({ account: { displayHint: result.account.displayHint } });
      } catch (error) {
        if (error instanceof DuplicateIdentifierError) {
          return fail(reply, 409, 'identifier_taken', MESSAGES.identifierTaken);
        }
        throw error;
      }
    },
  );

  app.post(
    AUTH_LOGIN_PATH,
    { schema: { body: CREDENTIALS_SCHEMA }, onRequest: csrfGuard },
    async (request, reply) => {
      const startedAt = Date.now();
      const body = request.body as CredentialsBody;
      const identifier = normalizeIdentifier(body.loginKind, body.identifier);
      if (!identifier.ok) {
        return fail(reply, 400, 'validation_failed', MESSAGES.invalidIdentifier);
      }
      const password = validatePassword(body.password);
      if (!password.ok) {
        return fail(reply, 400, 'validation_failed', MESSAGES.invalidPassword);
      }
      if (service.resolve(readToken(request)) !== null) {
        return fail(reply, 409, 'already_authenticated', MESSAGES.alreadyAuthenticated);
      }

      const identifierKey = `${identifier.value.kind}:${identifier.value.normalized}`;
      const ipBudget = limiter.consume(`login:ip:${request.ip}`, RULES.loginIp);
      if (ipBudget.blocked) {
        return limited(reply, ipBudget, MESSAGES.loginIpLimited);
      }
      const attemptKey = `login:attempt:${identifierKey}:${request.ip}`;
      const attemptBudget = limiter.consume(attemptKey, RULES.loginIdentifier);
      if (attemptBudget.blocked) {
        return limited(reply, attemptBudget, MESSAGES.loginAttemptLimited);
      }
      const failureKey = `login:fail:${identifierKey}`;
      const lockState = limiter.status(failureKey, RULES.loginFailures);
      if (lockState.blocked) {
        return limited(reply, lockState, MESSAGES.loginLocked);
      }

      const outcome = await service.login({
        identifier: identifier.value,
        password: password.value,
      });
      await holdOpen(startedAt, MIN_LOGIN_DURATION_MS);

      if (!outcome.ok) {
        limiter.consume(failureKey, RULES.loginFailures);
        return fail(reply, 401, 'invalid_credentials', MESSAGES.invalidCredentials);
      }

      limiter.reset(failureKey);
      limiter.reset(attemptKey);
      setSessionCookie(reply, cookiePolicy, outcome.value.session.token);
      return noStore(reply)
        .code(200)
        .type(JSON_TYPE)
        .send({ account: { displayHint: outcome.value.account.displayHint } });
    },
  );

  app.post(AUTH_LOGOUT_PATH, { onRequest: csrfGuard }, async (request, reply) => {
    const budget = limiter.consume(`session:ip:${request.ip}`, RULES.sessionIp);
    if (budget.blocked) {
      return limited(reply, budget, MESSAGES.sessionLimited);
    }
    const token = readToken(request);
    const revoked = service.revoke(token);
    reply.header('set-cookie', serializeClearedSessionCookie(cookiePolicy));
    if (!revoked) {
      return fail(reply, 401, 'unauthenticated', MESSAGES.unauthenticated);
    }
    return noStore(reply).code(204).send();
  });

  app.get(AUTH_SESSION_PATH, async (request, reply) => {
    const budget = limiter.consume(`session:ip:${request.ip}`, RULES.sessionIp);
    if (budget.blocked) {
      return limited(reply, budget, MESSAGES.sessionLimited);
    }
    const context = service.resolve(readToken(request));
    if (context === null) {
      return noStore(reply).code(200).type(JSON_TYPE).send({ authenticated: false });
    }
    return noStore(reply).code(200).type(JSON_TYPE).send({
      authenticated: true,
      account: { displayHint: context.displayHint, createdAt: context.accountCreatedAt },
    });
  });
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

function fail(
  reply: FastifyReply,
  status: number,
  code: Parameters<typeof apiError>[0],
  message: string,
): FastifyReply {
  return noStore(reply).code(status).type(JSON_TYPE).send(apiError(code, message));
}

function limited(
  reply: FastifyReply,
  decision: Extract<RateLimitStatus, { blocked: true }>,
  message: string,
): FastifyReply {
  return noStore(reply)
    .code(429)
    .header('retry-after', String(decision.retryAfterSeconds))
    .type(JSON_TYPE)
    .send(apiError('rate_limited', message));
}

function setSessionCookie(
  reply: FastifyReply,
  policy: SessionCookiePolicy,
  token: string,
): void {
  reply.header('set-cookie', serializeSessionCookie(policy, token));
}

async function holdOpen(startedAt: number, minimumMs: number): Promise<void> {
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, remaining));
}
