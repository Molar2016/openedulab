import type { FastifyInstance } from 'fastify';

import {
  CONTENT_LOCALES,
  MAX_CATALOG_ITEMS,
  type ContentExperiment,
  type ContentIndex,
  type ContentLocale,
} from '../domain/content-index.js';
import { accountOf, type SessionGate } from './auth-context.js';
import { apiError } from './errors.js';

/**
 * Protected content endpoints (design §7.2, R-05/R-07).
 *
 * Both routes are mounted behind `requireSession` as an `onRequest` hook, so the gate is
 * evaluated before query/param validation and no content metadata can be read by an
 * anonymous caller. Responses carry only indexed fields — never a filesystem path, never
 * a manifest file name.
 */

const TAG_PATTERN = '^[a-z0-9][a-z0-9-]*$';

const CATALOG_QUERY_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string', pattern: TAG_PATTERN, maxLength: 64 },
    grade: { type: 'string', pattern: TAG_PATTERN, maxLength: 64 },
    concept: { type: 'string', pattern: TAG_PATTERN, maxLength: 64 },
    q: { type: 'string', maxLength: 100 },
    locale: { type: 'string', enum: [...CONTENT_LOCALES] },
    limit: { type: 'integer', minimum: 1, maximum: MAX_CATALOG_ITEMS },
  },
};

const EXPERIMENT_PARAMS_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['experimentId'],
  properties: {
    experimentId: {
      type: 'string',
      pattern: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$',
      maxLength: 80,
    },
  },
};

interface CatalogQueryString {
  readonly subject?: string;
  readonly grade?: string;
  readonly concept?: string;
  readonly q?: string;
  readonly locale?: ContentLocale;
  readonly limit?: number;
}

export interface CatalogRouteOptions {
  readonly contentIndex: ContentIndex;
  readonly gate: SessionGate;
}

function catalogItem(entry: ContentExperiment, locale: ContentLocale): object {
  const text = entry.texts[locale];
  return {
    id: entry.id,
    slug: entry.slug,
    title: text.title,
    description: text.description,
    subjects: [...entry.subjects],
    grades: [...entry.grades],
    concepts: [...entry.concepts],
    contentVersion: entry.contentVersion,
    languages: [...entry.languages],
  };
}

export function registerContentRoutes(app: FastifyInstance, options: CatalogRouteOptions): void {
  const { contentIndex, gate } = options;

  app.get(
    '/api/catalog',
    { onRequest: gate.requireSession, schema: { querystring: CATALOG_QUERY_SCHEMA } },
    async (request, reply) => {
      // Touch the context so a wiring mistake fails loudly instead of serving content.
      accountOf(request);
      const query = request.query as CatalogQueryString;
      const locale: ContentLocale = query.locale ?? 'zh-CN';
      const items = contentIndex.list({
        ...(query.subject === undefined ? {} : { subject: query.subject }),
        ...(query.grade === undefined ? {} : { grade: query.grade }),
        ...(query.concept === undefined ? {} : { concept: query.concept }),
        ...(query.q === undefined ? {} : { q: query.q }),
        locale,
        limit: query.limit ?? MAX_CATALOG_ITEMS,
      });

      return reply
        .header('cache-control', 'no-store')
        .type('application/json; charset=utf-8')
        .send({ items: items.map((entry) => catalogItem(entry, locale)) });
    },
  );

  app.get(
    '/api/experiments/:experimentId',
    { onRequest: gate.requireSession, schema: { params: EXPERIMENT_PARAMS_SCHEMA } },
    async (request, reply) => {
      accountOf(request);
      const { experimentId } = request.params as { experimentId: string };
      const { locale } = request.query as { locale?: ContentLocale };
      const entry = contentIndex.find(experimentId);
      if (entry === undefined) {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .type('application/json; charset=utf-8')
          .send(apiError('not_found', 'No published experiment matches that id.'));
      }
      const text = entry.texts[locale ?? 'zh-CN'];
      return reply
        .header('cache-control', 'no-store')
        .type('application/json; charset=utf-8')
        .send({
          ...catalogItem(entry, locale ?? 'zh-CN'),
          title: text.title,
          description: text.description,
          moduleVersion: entry.moduleVersion,
          sdkVersionRange: entry.sdkVersionRange,
          reviewedStatus: entry.reviewedStatus,
          offlineSupport: entry.offlineSupport,
          updatedAt: entry.updatedAt,
          manifest: entry.manifest,
        });
    },
  );
}
