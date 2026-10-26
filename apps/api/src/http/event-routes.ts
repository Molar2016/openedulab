import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppConfig } from '../config.js';
import { insertEvent } from '../db/event-repository.js';
import { insertFeedback } from '../db/feedback-repository.js';
import type { ContentIndex } from '../domain/content-index.js';
import {
  deviceClassFrom,
  ingestEvents,
  normalizeEvents,
  normalizeFeedback,
  type IncomingEvent,
} from '../domain/events.js';
import { InMemoryRateLimiter, type RateLimitRule, type RateLimitStatus } from '../security/rate-limit.js';
import { accountOf, type SessionGate } from './auth-context.js';
import { createCsrfGuard } from './csrf.js';
import { apiError } from './errors.js';

/**
 * Diagnostics ingestion (design §7.6/§7.7).
 *
 * Both endpoints are "best effort": they answer 202 when a batch is only partly accepted,
 * and they never record an anonymous or caller-named account. They are also strictly
 * optional for the product — if they answer 429/503 or are switched off, the experiment,
 * the favorites and the recent-use list keep working (the SPA adapter swallows the
 * failure, and there is an E2E test for the degraded path).
 */

const JSON_TYPE = 'application/json; charset=utf-8';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Per-route body cap for events: 8 KB (design §4.5), smaller than the global 64 KB. */
export const EVENTS_BODY_LIMIT = 8 * 1024;
const MAX_BATCH = 20;

const RULES = {
  eventsPerMinute: { limit: 120, windowMs: MINUTE_MS },
  eventsPerDay: { limit: 3000, windowMs: DAY_MS },
  feedbackPerHour: { limit: 5, windowMs: 60 * MINUTE_MS },
} as const satisfies Record<string, RateLimitRule>;

const ENVELOPE_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'appVersion', 'visitId', 'events'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    appVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$', maxLength: 32 },
    visitId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
    events: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_BATCH,
      items: {
        type: 'object',
        // The batch envelope is strict, but a single event is not: one event carrying an
        // extra field ("sliderValue", "message", "url") must not discard the other 19.
        // Unknown keys are simply never read, so they cannot reach a column.
        required: ['clientEventId', 'type', 'experimentId', 'contentVersion', 'locale'],
        properties: {
          clientEventId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
          type: { type: 'string', maxLength: 48 },
          experimentId: { type: 'string', maxLength: 80 },
          contentVersion: { type: 'string', maxLength: 32 },
          locale: { type: 'string', maxLength: 8 },
          controlGroup: { type: 'string', maxLength: 32 },
          interactionBucket: { type: 'string', maxLength: 8 },
          errorCode: { type: 'string', maxLength: 32 },
        },
      },
    },
  },
};

const FEEDBACK_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['experimentId', 'contentVersion', 'appVersion', 'category'],
  properties: {
    experimentId: { type: 'string', maxLength: 80 },
    contentVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    appVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' },
    category: { type: 'string', maxLength: 16 },
    locale: { type: 'string', enum: ['zh-CN', 'en'] },
    message: { type: 'string', maxLength: 8000 },
  },
};

export interface EventRouteOptions {
  readonly config: AppConfig;
  readonly db: DatabaseSync;
  readonly contentIndex: ContentIndex;
  readonly gate: SessionGate;
  readonly now: () => number;
}

export function registerEventRoutes(app: FastifyInstance, options: EventRouteOptions): void {
  const { config, db, contentIndex, gate, now } = options;
  const csrfGuard = createCsrfGuard(config);
  const limiter = new InMemoryRateLimiter(now);
  const writeHooks = [gate.requireSession, csrfGuard];

  app.post(
    '/api/events',
    {
      onRequest: writeHooks,
      bodyLimit: EVENTS_BODY_LIMIT,
      schema: { body: ENVELOPE_SCHEMA },
    },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const body = request.body as {
        schemaVersion: number;
        appVersion: string;
        visitId: string;
        events: IncomingEvent[];
      };

      const dropAll = (): FastifyReply =>
        reply
          .code(202)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send({ accepted: 0, dropped: body.events.length });

      // Switched off by the operator: accept quietly, store nothing. The client must not
      // see an error and must not retry forever.
      if (!config.eventsEnabled) {
        return dropAll();
      }

      const minute = limiter.consume(`events:m:${accountId}`, RULES.eventsPerMinute);
      if (minute.blocked) {
        return limited(reply, minute, 'Too many diagnostic events. Try again later.');
      }
      const day = limiter.status(`events:d:${accountId}`, RULES.eventsPerDay);
      if (day.blocked) {
        // Daily cap: still a 202 so the experiment is unaffected, but nothing is stored.
        limiter.consume(`events:d:${accountId}`, RULES.eventsPerDay);
        return dropAll();
      }
      limiter.consume(`events:d:${accountId}`, RULES.eventsPerDay);

      const normalized = normalizeEvents({
        events: body.events,
        appVersion: body.appVersion,
        visitId: body.visitId,
        accountId,
        deviceClass: deviceClassFrom(request.headers['user-agent']),
        contentIndex,
        receivedAt: now(),
      });
      const result = ingestEvents(db, normalized.rows, normalized.dropped);

      return reply
        .code(202)
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send({ accepted: result.accepted, dropped: result.dropped });
    },
  );

  app.post(
    '/api/feedback',
    { onRequest: writeHooks, schema: { body: FEEDBACK_SCHEMA } },
    async (request, reply) => {
      const { accountId } = accountOf(request);
      const budget = limiter.consume(`feedback:${accountId}`, RULES.feedbackPerHour);
      if (budget.blocked) {
        return limited(reply, budget, 'Too many reports from this account. Try again later.');
      }

      const normalized = normalizeFeedback(request.body as Record<string, unknown>, contentIndex);
      if (!normalized.ok) {
        return reply
          .code(400)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('validation_failed', 'This report cannot be accepted as sent.'));
      }

      const createdAt = now();
      const id = randomUUID();
      insertFeedback(db, {
        id,
        accountId,
        experimentId: normalized.value.experimentId,
        contentVersion: normalized.value.contentVersion,
        appVersion: normalized.value.appVersion,
        category: normalized.value.category,
        message: normalized.value.message,
        createdAt,
      });

      // The category is also recorded as an event (no text, no id back-reference).
      if (config.eventsEnabled) {
        insertEvent(db, {
          id: randomUUID(),
          accountId,
          experimentId: normalized.value.experimentId,
          contentVersion: normalized.value.contentVersion,
          appVersion: normalized.value.appVersion,
          locale: (request.body as { locale?: string }).locale ?? 'zh-CN',
          eventType: 'feedback_submitted',
          controlGroup: '',
          interactionBucket: '',
          errorCode: '',
          issueCategory: normalized.value.category,
          deviceClass: deviceClassFrom(request.headers['user-agent']),
          visitId: `feedback-${id.slice(0, 24)}`,
          clientEventId: `feedback-${id}`,
          dedupeKey: `feedback:${id}`,
          occurredAtMin: Math.floor(createdAt / 60_000) * 60_000,
          receivedAt: createdAt,
        });
      }

      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send({ id });
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
