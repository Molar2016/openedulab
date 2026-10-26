import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppConfig } from '../config.js';
import { addFavorite, listFavorites, removeFavorite } from '../db/favorite-repository.js';
import { listRecentUse, recordRecentUse } from '../db/recent-repository.js';
import type { ContentIndex } from '../domain/content-index.js';
import { InMemoryRateLimiter, type RateLimitRule, type RateLimitStatus } from '../security/rate-limit.js';
import { accountOf, type SessionGate } from './auth-context.js';
import { createCsrfGuard, type CsrfGuard } from './csrf.js';
import { apiError } from './errors.js';

/**
 * Personal data (design §7.3/§7.4, R-11/R-12/R-13/R-15).
 *
 * These are the "my" endpoints: strongly consistent, written synchronously on a user
 * action, and never reconstructable from usage events. Every handler reads `accountOf()`
 * — the account id comes from the session and from nowhere else — and every SQL statement
 * is scoped by it.
 *
 * The gate runs as `onRequest` before the CSRF guard, so an anonymous caller learns
 * nothing about CSRF rules and gets the same 401 as everywhere else.
 */

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPERIMENT_ID_PATTERN = '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$';
const MINUTE_MS = 60 * 1000;
const MAX_RECENT_LIMIT = 50;
const DEFAULT_RECENT_LIMIT = 20;

const RULES = {
  favoriteWrite: { limit: 60, windowMs: MINUTE_MS },
  recentWrite: { limit: 120, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitRule>;

const PARAMS_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['experimentId'],
  properties: {
    experimentId: { type: 'string', pattern: EXPERIMENT_ID_PATTERN, maxLength: 80 },
  },
};

const RECENT_QUERY_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MAX_RECENT_LIMIT },
  },
};

const RECENT_BODY_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['experimentId'],
  properties: {
    experimentId: { type: 'string', pattern: EXPERIMENT_ID_PATTERN, maxLength: 80 },
  },
};

const MESSAGES = {
  unknownExperiment: 'No published experiment matches that id.',
  favoriteLimited: 'Too many favorite changes. Wait a minute and try again.',
  recentLimited: 'Too many recent-use updates. Wait a minute and try again.',
} as const;

export interface MeRouteOptions {
  readonly config: AppConfig;
  readonly db: DatabaseSync;
  readonly contentIndex: ContentIndex;
  readonly gate: SessionGate;
  readonly now: () => number;
}

export function registerMeRoutes(app: FastifyInstance, options: MeRouteOptions): void {
  const { config, db, contentIndex, gate, now } = options;
  const csrfGuard: CsrfGuard = createCsrfGuard(config);
  const limiter = new InMemoryRateLimiter(now);
  const writeHooks = [gate.requireSession, csrfGuard];

  const denyUnknownExperiment = (reply: FastifyReply): FastifyReply =>
    reply
      .code(404)
      .header('cache-control', 'no-store')
      .type(JSON_TYPE)
      .send(apiError('not_found', MESSAGES.unknownExperiment));

  app.get('/api/me/favorites', { onRequest: gate.requireSession }, async (request, reply) => {
    const { accountId } = accountOf(request);
    return reply
      .header('cache-control', 'no-store')
      .type(JSON_TYPE)
      .send({ items: listFavorites(db, accountId) });
  });

  app.put(
    '/api/me/favorites/:experimentId',
    { onRequest: writeHooks, schema: { params: PARAMS_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const budget = limiter.consume(`favorite:${accountId}`, RULES.favoriteWrite);
      if (budget.blocked) return limited(reply, budget, MESSAGES.favoriteLimited);

      const { experimentId } = request.params as { experimentId: string };
      if (contentIndex.find(experimentId) === undefined) {
        return denyUnknownExperiment(reply);
      }
      const result = addFavorite(db, accountId, experimentId, now());
      return reply
        .code(result.created ? 201 : 200)
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send({ experimentId, createdAt: result.createdAt });
    },
  );

  app.delete(
    '/api/me/favorites/:experimentId',
    { onRequest: writeHooks, schema: { params: PARAMS_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const budget = limiter.consume(`favorite:${accountId}`, RULES.favoriteWrite);
      if (budget.blocked) return limited(reply, budget, MESSAGES.favoriteLimited);

      const { experimentId } = request.params as { experimentId: string };
      // Idempotent on purpose: removing something that was never there is not an error,
      // and answering 404 would confirm whether another account has this favorite.
      removeFavorite(db, accountId, experimentId);
      return reply.code(204).header('cache-control', 'no-store').send();
    },
  );

  app.get(
    '/api/me/recent',
    { onRequest: gate.requireSession, schema: { querystring: RECENT_QUERY_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const { limit } = request.query as { limit?: number };
      return reply
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send({ items: listRecentUse(db, accountId, limit ?? DEFAULT_RECENT_LIMIT) });
    },
  );

  app.post(
    '/api/me/recent',
    { onRequest: writeHooks, schema: { body: RECENT_BODY_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const budget = limiter.consume(`recent:${accountId}`, RULES.recentWrite);
      if (budget.blocked) return limited(reply, budget, MESSAGES.recentLimited);

      const { experimentId } = request.body as { experimentId: string };
      if (contentIndex.find(experimentId) === undefined) {
        return denyUnknownExperiment(reply);
      }
      recordRecentUse(db, accountId, experimentId, now());
      return reply.code(204).header('cache-control', 'no-store').send();
    },
  );
}

function limited(
  reply: FastifyReply,
  decision: Extract<RateLimitStatus, { blocked: true }>,
  message: string,
): FastifyReply {
  return reply
    .code(429)
    .header('cache-control', 'no-store')
    .header('retry-after', String(decision.retryAfterSeconds))
    .type(JSON_TYPE)
    .send(apiError('rate_limited', message));
}

/** The four personal-data paths this module owns (checked by the route inventory test). */
export const ME_ROUTE_PATHS: readonly string[] = Object.freeze([
  '/api/me/favorites',
  '/api/me/favorites/:experimentId',
  '/api/me/recent',
]);
