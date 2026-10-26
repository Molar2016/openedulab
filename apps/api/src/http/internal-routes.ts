import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config.js';
import {
  accountTimeline,
  controlDistribution,
  exportEvents,
  funnelCounts,
  overviewRows,
} from '../db/event-repository.js';
import { exportFeedback, insertAudit, type AuditRecord } from '../db/feedback-repository.js';
import type { ContentIndex } from '../domain/content-index.js';
import { InMemoryRateLimiter, type RateLimitRule } from '../security/rate-limit.js';
import { apiError } from './errors.js';

/**
 * Operator channel (design §7.8, D9).
 *
 * Access is a Bearer token from the environment, not an account: a normal user cannot be
 * granted it by mistake, and there is no cookie path. When `OEL_OPERATOR_TOKEN` is unset
 * the routes are **not registered**, so the answer is the same 404 an unknown path gets —
 * the channel does not advertise itself.
 *
 * Every read that touches one account, and every export, writes an `internal_audit` row
 * (operator label, action, target, purpose, row count). Without that, "minimum scope and
 * purpose" would be a claim rather than a record.
 */

const JSON_TYPE = 'application/json; charset=utf-8';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_WINDOW_DAYS = 180;
const MAX_TIMELINE_ROWS = 500;
const MAX_EXPORT_ROWS = 50_000;
const DEFAULT_WINDOW_MS = 7 * DAY_MS;
const MIN_REASON_LENGTH = 8;

const RULES = {
  internal: { limit: 60, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitRule>;

const WINDOW_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'integer', minimum: 0 },
    to: { type: 'integer', minimum: 0 },
    reason: { type: 'string', maxLength: 200 },
    experimentId: { type: 'string', maxLength: 80 },
  },
};

interface WindowQuery {
  readonly from?: number;
  readonly to?: number;
  readonly reason?: string;
  readonly experimentId?: string;
}

export interface InternalRouteOptions {
  readonly config: AppConfig;
  readonly db: DatabaseSync;
  readonly contentIndex: ContentIndex;
  readonly now: () => number;
}

interface ResolvedWindow {
  readonly from: number;
  readonly to: number;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function registerInternalRoutes(app: FastifyInstance, options: InternalRouteOptions): void {
  const { config, db, contentIndex, now } = options;

  // No token configured: mount nothing at all.
  if (config.operatorToken === null) {
    return;
  }

  const expected = hashToken(config.operatorToken);
  const limiter = new InMemoryRateLimiter(now);

  /**
   * Returns null when the caller may proceed, or the reply that was already sent. A wrong
   * token, a missing header and a user session all produce the same 404 (design §4.5).
   */
  const authorize = (request: FastifyRequest, reply: FastifyReply): FastifyReply | null => {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
    const presented = match?.[1];
    if (presented === undefined) {
      return notFound(reply);
    }
    const candidate = hashToken(presented);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      return notFound(reply);
    }
    const budget = limiter.consume('internal', RULES.internal);
    if (budget.blocked) {
      return reply
        .code(429)
        .header('cache-control', 'no-store')
        .header('retry-after', String(budget.retryAfterSeconds))
        .type(JSON_TYPE)
        .send(apiError('rate_limited', 'Too many operator requests. Try again later.'));
    }
    return null;
  };

  const windowFor = (request: FastifyRequest): ResolvedWindow | null => {
    const query = request.query as WindowQuery;
    const to = query.to ?? now() + MINUTE_MS;
    const from = query.from ?? to - DEFAULT_WINDOW_MS;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return null;
    if (to - from > MAX_WINDOW_DAYS * DAY_MS) return null;
    return { from, to };
  };

  /** A purpose is mandatory wherever the answer can identify an account. */
  const reasonOf = (request: FastifyRequest): string | null => {
    const reason = (request.query as WindowQuery).reason;
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) return null;
    return reason.trim();
  };

  const labelOf = (request: FastifyRequest): string | null => {
    const label = request.headers['x-operator-label'];
    if (typeof label !== 'string' || label.trim() === '') return null;
    return label.trim().slice(0, 64);
  };

  const audit = (record: Omit<AuditRecord, 'id' | 'createdAt'>): void => {
    insertAudit(db, { ...record, id: randomUUID(), createdAt: now() });
  };

  const dataGaps = (window: ResolvedWindow): object[] =>
    config.eventsEnabled ? [] : [{ from: window.from, to: window.to, reason: 'events_disabled' }];

  const badRequest = (reply: FastifyReply, message: string): FastifyReply =>
    reply.code(400).header('cache-control', 'no-store').type(JSON_TYPE).send(apiError('validation_failed', message));

  app.get(
    '/api/internal/overview',
    { schema: { querystring: WINDOW_SCHEMA } },
    async (request, reply) => {
      const denied = authorize(request, reply);
      if (denied !== null) return denied;
      const window = windowFor(request);
      if (window === null) return badRequest(reply, 'from/to must be integers with 0 < to-from <= 180 days.');

      if (!config.eventsEnabled) {
        return reply
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send({ window, generatedAt: now(), dataGaps: dataGaps(window), experiments: [] });
      }

      const experiments = overviewRows(db, window.from, window.to).map((row) => ({
        experimentId: row.experimentId,
        contentVersions: row.contentVersions.split(',').filter((value) => value !== ''),
        openAccounts: row.openAccounts,
        openVisits: row.openVisits,
        interactedVisits: row.interactedVisits,
        firstInteractionRate: row.openVisits === 0 ? 0 : row.interactedVisits / row.openVisits,
        opens: row.opens,
        resets: row.resets,
        resetRatio: row.opens === 0 ? 0 : row.resets / row.opens,
        fullscreens: row.fullscreens,
        fullscreenRatio: row.opens === 0 ? 0 : row.fullscreens / row.opens,
        errors: row.errors,
        errorRate: row.opens === 0 ? 0 : row.errors / row.opens,
      }));

      return reply
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send({ window, generatedAt: now(), dataGaps: dataGaps(window), experiments });
    },
  );

  app.get(
    '/api/internal/experiments/:experimentId/funnel',
    { schema: { querystring: WINDOW_SCHEMA } },
    async (request, reply) => {
      const denied = authorize(request, reply);
      if (denied !== null) return denied;
      const window = windowFor(request);
      if (window === null) return badRequest(reply, 'from/to must be integers with 0 < to-from <= 180 days.');

      const { experimentId } = request.params as { experimentId: string };
      const experiment = contentIndex.find(experimentId);
      if (experiment === undefined) {
        return notFound(reply);
      }
      const counts = config.eventsEnabled ? funnelCounts(db, experimentId, window.from, window.to) : {};
      const controls = config.eventsEnabled ? controlDistribution(db, experimentId, window.from, window.to) : [];

      return reply
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send({
          window,
          generatedAt: now(),
          dataGaps: dataGaps(window),
          experimentId,
          contentVersion: experiment.contentVersion,
          counts,
          controls,
        });
    },
  );

  app.get(
    '/api/internal/accounts/:accountId/timeline',
    { schema: { querystring: WINDOW_SCHEMA } },
    async (request, reply) => {
      const denied = authorize(request, reply);
      if (denied !== null) return denied;
      const window = windowFor(request);
      if (window === null) return badRequest(reply, 'from/to must be integers with 0 < to-from <= 180 days.');
      const reason = reasonOf(request);
      if (reason === null) {
        return badRequest(reply, `A purpose is required: reason must be at least ${String(MIN_REASON_LENGTH)} characters.`);
      }
      const label = labelOf(request);
      if (label === null) {
        return badRequest(reply, 'X-Operator-Label is required and must not be empty.');
      }

      const { accountId } = request.params as { accountId: string };
      const items = config.eventsEnabled
        ? accountTimeline(db, accountId, window.from, window.to, MAX_TIMELINE_ROWS + 1)
        : [];
      const truncated = items.length > MAX_TIMELINE_ROWS;
      const visible = items.slice(0, MAX_TIMELINE_ROWS);

      audit({
        operatorLabel: label,
        action: 'account_timeline',
        targetType: 'account',
        targetId: accountId,
        reason,
        rowCount: visible.length,
      });

      return reply
        .header('cache-control', 'no-store')
        .type(JSON_TYPE)
        .send({
          window,
          generatedAt: now(),
          dataGaps: dataGaps(window),
          accountId,
          items: visible,
          truncated,
        });
    },
  );

  app.get(
    '/api/internal/export/events.csv',
    { schema: { querystring: WINDOW_SCHEMA } },
    async (request, reply) => {
      const denied = authorize(request, reply);
      if (denied !== null) return denied;
      const window = windowFor(request);
      if (window === null) return badRequest(reply, 'from/to must be integers with 0 < to-from <= 180 days.');
      const reason = reasonOf(request);
      if (reason === null) {
        return badRequest(reply, `A purpose is required: reason must be at least ${String(MIN_REASON_LENGTH)} characters.`);
      }
      const label = labelOf(request);
      if (label === null) {
        return badRequest(reply, 'X-Operator-Label is required and must not be empty.');
      }

      const query = request.query as WindowQuery;
      const rows = config.eventsEnabled
        ? exportEvents(db, window.from, window.to, query.experimentId ?? null, MAX_EXPORT_ROWS + 1)
        : [];
      if (rows.length > MAX_EXPORT_ROWS) {
        return reply
          .code(413)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('payload_too_large', 'Too many rows; narrow the window or the experiment.'));
      }

      audit({
        operatorLabel: label,
        action: 'export_events',
        targetType: query.experimentId === undefined ? 'window' : 'experiment',
        targetId: query.experimentId ?? `${String(window.from)}-${String(window.to)}`,
        reason,
        rowCount: rows.length,
      });

      const header =
        'occurred_at_min,experiment_id,content_version,app_version,locale,event_type,' +
        'control_group,interaction_bucket,error_code,device_class,account_id';
      const lines = rows.map((row) =>
        [
          String(row.occurredAtMin),
          row.experimentId,
          row.contentVersion,
          row.appVersion,
          row.locale,
          row.eventType,
          row.controlGroup,
          row.interactionBucket,
          row.errorCode,
          row.deviceClass,
          row.accountId,
        ]
          .map(csvCell)
          .join(','),
      );

      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="events.csv"')
        .send([header, ...lines].join('\n') + '\n');
    },
  );

  app.get(
    '/api/internal/export/feedback.csv',
    { schema: { querystring: WINDOW_SCHEMA } },
    async (request, reply) => {
      const denied = authorize(request, reply);
      if (denied !== null) return denied;
      const window = windowFor(request);
      if (window === null) return badRequest(reply, 'from/to must be integers with 0 < to-from <= 180 days.');
      const reason = reasonOf(request);
      if (reason === null) {
        return badRequest(reply, `A purpose is required: reason must be at least ${String(MIN_REASON_LENGTH)} characters.`);
      }
      const label = labelOf(request);
      if (label === null) {
        return badRequest(reply, 'X-Operator-Label is required and must not be empty.');
      }

      // Feedback is independent of the event switch: turning diagnostics off does not hide
      // reports a person deliberately submitted.
      const rows = exportFeedback(db, window.from, window.to, MAX_EXPORT_ROWS + 1);
      if (rows.length > MAX_EXPORT_ROWS) {
        return reply
          .code(413)
          .header('cache-control', 'no-store')
          .type(JSON_TYPE)
          .send(apiError('payload_too_large', 'Too many rows; narrow the window.'));
      }

      audit({
        operatorLabel: label,
        action: 'export_feedback',
        targetType: 'window',
        targetId: `${String(window.from)}-${String(window.to)}`,
        reason,
        rowCount: rows.length,
      });

      const header = 'id,created_at,experiment_id,content_version,app_version,category,message,account_id';
      const lines = rows.map((row) =>
        [
          row.id,
          String(row.createdAt),
          row.experimentId,
          row.contentVersion,
          row.appVersion,
          row.category,
          row.message,
          row.accountId,
        ]
          .map(csvCell)
          .join(','),
      );

      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="feedback.csv"')
        .send([header, ...lines].join('\n') + '\n');
    },
  );
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .header('cache-control', 'no-store')
    .type(JSON_TYPE)
    .send(apiError('not_found', 'No route matches this request.'));
}

/** RFC 4180 style quoting; also neutralises a leading `=`/`+`/`-`/`@` (CSV injection). */
function csvCell(value: string): string {
  const neutralised = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

export { MAX_EXPORT_ROWS, MAX_TIMELINE_ROWS };
