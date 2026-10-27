import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config.js';
import { addFavorite, listFavorites, removeFavorite } from '../db/favorite-repository.js';
import { listRecentUse, recordRecentUse } from '../db/recent-repository.js';
import {
  getPlacementState,
  putPlacementState,
} from '../db/placement-state-repository.js';
import {
  deleteSavedState,
  getSavedState,
  putSavedState,
} from '../db/saved-state-repository.js';
import type { ContentIndex } from '../domain/content-index.js';
import { MAX_STATE_PAYLOAD_BYTES, validateStateValues, type StateRejection } from '../domain/state-validator.js';
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
  // Saving is a deliberate click, not a stream: 30 copies of one snapshot per minute is
  // far above any real use and still bounds an accidental loop.
  savedStateWrite: { limit: 30, windowMs: MINUTE_MS },
  // Same budget as the tool-level snapshot: a deliberate click, not a stream.
  placementStateWrite: { limit: 30, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitRule>;

const PARAMS_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['experimentId'],
  properties: {
    experimentId: { type: 'string', pattern: EXPERIMENT_ID_PATTERN, maxLength: 80 },
  },
};

const PLACEMENT_PARAMS_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['placementId'],
  properties: {
    // A placement id is content-derived and must stay in the same shape as the index:
    // rejecting the shape here means a crafted path never reaches a lookup at all.
    placementId: { type: 'string', pattern: EXPERIMENT_ID_PATTERN, maxLength: 120 },
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

/**
 * The parameter *values* cannot be described statically — their keys come from the
 * experiment's own schema — so this only enforces the envelope; `validateStateValues`
 * is the authority on the contents.
 */
const SAVED_STATE_BODY_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['stateSchemaVersion', 'values'],
  properties: {
    stateSchemaVersion: { type: 'integer', minimum: 1, maximum: 1000 },
    values: { type: 'object' },
  },
};

/** Placement snapshots carry the placement's own version, not just the schema version. */
const PLACEMENT_STATE_BODY_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['placementVersion', 'stateSchemaVersion', 'values'],
  properties: {
    placementVersion: { type: 'integer', minimum: 1, maximum: 100000 },
    stateSchemaVersion: { type: 'integer', minimum: 1, maximum: 1000 },
    values: { type: 'object' },
  },
};

const MESSAGES = {
  unknownExperiment: 'No published experiment matches that id.',
  favoriteLimited: 'Too many favorite changes. Wait a minute and try again.',
  recentLimited: 'Too many recent-use updates. Wait a minute and try again.',
  noSavedState: 'No saved settings for this experiment.',
  savedStateLimited: 'Too many save attempts. Wait a minute and try again.',
  noSaving: 'This experiment does not offer saved settings.',
  unreadableSnapshot: 'The saved settings cannot be read by this version. Save again to replace them.',
  unknownPlacement: 'No published curriculum entry matches that id.',
  noPlacementState: 'No saved settings for this curriculum entry.',
  placementMoved:
    'This curriculum entry has a new version; reload the page to use the current preset.',
} as const;

/** Why a saved-parameter payload was refused, in terms a user can act on. */
function stateRejectionMessage(reason: StateRejection, fields: readonly string[]): string {
  const list = fields.join(', ');
  switch (reason) {
    case 'not_an_object':
      return 'Saved settings must be an object of parameter values.';
    case 'unknown_key':
      return `Saved settings include a parameter this experiment does not have: ${list}.`;
    case 'missing_key':
      return `Saved settings are missing a parameter: ${list}.`;
    case 'invalid_number':
      return `Saved settings must use a number for: ${list}.`;
    case 'out_of_range':
      return `Saved settings are outside the allowed range for: ${list}.`;
    case 'off_step':
      return `Saved settings are not on the allowed step for: ${list}.`;
    case 'invalid_enum':
      return `Saved settings use a value this experiment does not allow for: ${list}.`;
    case 'too_large':
      return `Saved settings exceed ${String(MAX_STATE_PAYLOAD_BYTES)} bytes.`;
  }
}

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

  /**
   * Runs before AJV, which would otherwise coerce `"1"` into `1`. Version handshakes must
   * fail loudly: a stale page has to reload, not silently write under the new schema.
   */
  const requireNumericSchemaVersion = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const body = request.body;
    if (typeof body !== 'object' || body === null) return undefined;
    for (const field of ['stateSchemaVersion', 'placementVersion'] as const) {
      const version = (body as Record<string, unknown>)[field];
      if (version === undefined) continue; // AJV reports a missing field itself.
      if (typeof version === 'number' && Number.isInteger(version)) continue;
      return reply
        .code(400)
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send(apiError('validation_failed', `${field} must be an integer.`));
    }
    return undefined;
  };

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

  // --- Curriculum placement snapshots (ADR-003) -----------------------------------------
  //
  // A chapter entry reuses one tool but owns its own snapshot. Scope is the placement, and
  // the row is looked up by (session account, placement) only: the tool-level snapshot in
  // `saved_state` is never read here and never written to. `placementVersion` is part of the
  // handshake, so a chapter whose preset changed cannot silently apply an old row.

  app.get(
    '/api/me/placement-state/:placementId',
    { onRequest: gate.requireSession, schema: { params: PLACEMENT_PARAMS_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const { placementId } = request.params as { placementId: string };
      const found = contentIndex.findPlacement(placementId);
      if (found === undefined) {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('not_found', MESSAGES.unknownPlacement));
      }
      const row = getPlacementState(db, accountId, placementId);
      if (row === undefined) {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('not_found', MESSAGES.noPlacementState));
      }
      let values: unknown;
      try {
        values = JSON.parse(row.payload) as unknown;
      } catch {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('state_schema_incompatible', MESSAGES.unreadableSnapshot));
      }
      return reply.header('cache-control', 'no-store').type(JSON_TYPE).send({
        placementId: row.placementId,
        experimentId: row.experimentId,
        placementVersion: row.placementVersion,
        contentVersion: row.contentVersion,
        stateSchemaVersion: row.stateSchemaVersion,
        values,
        updatedAt: row.updatedAt,
      });
    },
  );

  app.put(
    '/api/me/placement-state/:placementId',
    {
      onRequest: writeHooks,
      preValidation: requireNumericSchemaVersion,
      schema: { params: PLACEMENT_PARAMS_SCHEMA, body: PLACEMENT_STATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const budget = limiter.consume(`placement-state:${accountId}`, RULES.placementStateWrite);
      if (budget.blocked) return limited(reply, budget, MESSAGES.savedStateLimited);

      const { placementId } = request.params as { placementId: string };
      const found = contentIndex.findPlacement(placementId);
      if (found === undefined) {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('not_found', MESSAGES.unknownPlacement));
      }
      const { placement, experiment } = found;
      const schema = experiment.stateSchema;
      if (schema === null) {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('state_schema_incompatible', MESSAGES.noSaving));
      }

      const body = request.body as {
        placementVersion: number;
        stateSchemaVersion: number;
        values: unknown;
      };
      if (body.placementVersion !== placement.version) {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('state_schema_incompatible', MESSAGES.placementMoved));
      }
      if (body.stateSchemaVersion !== schema.version) {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(
            apiError(
              'state_schema_incompatible',
              `This experiment stores settings as schema version ${String(schema.version)}; reload the page and try again.`,
            ),
          );
      }

      const validated = validateStateValues(schema, body.values);
      if (!validated.ok) {
        return reply
          .code(400)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('state_invalid', stateRejectionMessage(validated.reason, validated.fields)));
      }

      const updatedAt = putPlacementState(db, accountId, placementId, {
        experimentId: experiment.id,
        placementVersion: placement.version,
        contentVersion: experiment.contentVersion,
        stateSchemaVersion: schema.version,
        payload: validated.payload,
        updatedAt: now(),
      });

      return reply.header('cache-control', 'no-store').type(JSON_TYPE).send({
        placementId,
        experimentId: experiment.id,
        placementVersion: placement.version,
        contentVersion: experiment.contentVersion,
        stateSchemaVersion: schema.version,
        values: validated.values,
        updatedAt,
      });
    },
  );

  // --- Saved parameter snapshots (design §7.5, R-17/R-18) -------------------------------
  //
  // Personal data with a strong consistency requirement: written only on an explicit save,
  // one row per (account, experiment), never reconstructed from diagnostics and never
  // written into them. The values live in this module only; `event-routes.ts` cannot read
  // them and nothing here calls the analytics writer.

  app.get(
    '/api/me/saved-state/:experimentId',
    { onRequest: gate.requireSession, schema: { params: PARAMS_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const { experimentId } = request.params as { experimentId: string };
      if (contentIndex.find(experimentId) === undefined) {
        return denyUnknownExperiment(reply);
      }
      const row = getSavedState(db, accountId, experimentId);
      if (row === undefined) {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('not_found', MESSAGES.noSavedState));
      }
      let values: unknown;
      try {
        values = JSON.parse(row.payload) as unknown;
      } catch {
        // A stored payload that no longer parses is treated as unusable, not as a 500:
        // the user can replace it, and the client offers exactly that.
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('state_schema_incompatible', MESSAGES.unreadableSnapshot));
      }
      return reply.header('cache-control', 'no-store').type(JSON_TYPE).send({
        experimentId,
        contentVersion: row.contentVersion,
        stateSchemaVersion: row.stateSchemaVersion,
        values,
        updatedAt: row.updatedAt,
      });
    },
  );

  app.put(
    '/api/me/saved-state/:experimentId',
    {
      onRequest: writeHooks,
      // Fastify's AJV coerces "1" into 1 for an `integer` field. For a version handshake that
      // is the wrong direction: a client that strings its version is a client bug, and this
      // hook (which runs before schema validation) says so instead of quietly agreeing.
      preValidation: requireNumericSchemaVersion,
      schema: { params: PARAMS_SCHEMA, body: SAVED_STATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const budget = limiter.consume(`saved-state:${accountId}`, RULES.savedStateWrite);
      if (budget.blocked) return limited(reply, budget, MESSAGES.savedStateLimited);

      const { experimentId } = request.params as { experimentId: string };
      const experiment = contentIndex.find(experimentId);
      if (experiment === undefined) {
        return denyUnknownExperiment(reply);
      }
      const schema = experiment.stateSchema;
      if (schema === null) {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('state_schema_incompatible', MESSAGES.noSaving));
      }

      const body = request.body as { stateSchemaVersion: number; values: unknown };
      if (body.stateSchemaVersion !== schema.version) {
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(
            apiError(
              'state_schema_incompatible',
              `This experiment stores settings as schema version ${String(schema.version)}; reload the page and try again.`,
            ),
          );
      }

      const validated = validateStateValues(schema, body.values);
      if (!validated.ok) {
        return reply
          .code(400)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('state_invalid', stateRejectionMessage(validated.reason, validated.fields)));
      }

      const updatedAt = putSavedState(db, accountId, experimentId, {
        contentVersion: experiment.contentVersion,
        stateSchemaVersion: schema.version,
        payload: validated.payload,
        updatedAt: now(),
      });

      return reply.header('cache-control', 'no-store').type(JSON_TYPE).send({
        experimentId,
        contentVersion: experiment.contentVersion,
        stateSchemaVersion: schema.version,
        values: validated.values,
        updatedAt,
      });
    },
  );

  app.delete(
    '/api/me/saved-state/:experimentId',
    { onRequest: writeHooks, schema: { params: PARAMS_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const budget = limiter.consume(`saved-state:${accountId}`, RULES.savedStateWrite);
      if (budget.blocked) return limited(reply, budget, MESSAGES.savedStateLimited);

      const { experimentId } = request.params as { experimentId: string };
      // Idempotent, like favorites: answering 404 would describe another account's rows.
      deleteSavedState(db, accountId, experimentId);
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

/** The personal-data paths this module owns (all of them in the route inventory). */
export const ME_ROUTE_PATHS: readonly string[] = Object.freeze([
  '/api/me/favorites',
  '/api/me/favorites/:experimentId',
  '/api/me/recent',
  '/api/me/saved-state/:experimentId',
  '/api/me/placement-state/:placementId',
]);
