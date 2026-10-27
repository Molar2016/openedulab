import type { FastifyInstance } from 'fastify';

import {
  CONTENT_LOCALES,
  MAX_CATALOG_ITEMS,
  type ContentExperiment,
  type ContentIndex,
  type ContentLocale,
} from '../domain/content-index.js';
import type {
  CurriculumCatalog,
  CurriculumPlacement,
  PlacementNode,
} from '../domain/curriculum.js';
import { accountOf, type SessionGate } from './auth-context.js';
import { apiError } from './errors.js';

/**
 * Protected content endpoints (design §7.2, R-05/R-07).
 *
 * All three routes are mounted behind `requireSession` as an `onRequest` hook, so the gate
 * is evaluated before query/param validation and no content metadata can be read by an
 * anonymous caller. Responses carry only indexed fields — never a filesystem path, never
 * a manifest or curriculum file name.
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

/**
 * `locale` is validated here, not read leniently in the handler: without this schema any
 * string reached `entry.texts[value]`, so `?locale=fr` threw (500) and `?locale=__proto__`
 * answered 200 with missing text. A caller-controlled string must not decide which object
 * property is read.
 */
const EXPERIMENT_QUERY_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  properties: {
    locale: { type: 'string', enum: [...CONTENT_LOCALES] },
  },
};

const CURRICULUM_QUERY_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  properties: {
    locale: { type: 'string', enum: [...CONTENT_LOCALES] },
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

/**
 * One curriculum directory entry (ADR-003): the tool it reuses, its stable id and version,
 * where it sits in the edition/book/chapter/section tree, the localized texts and the preset
 * the context page opens with. The preset is content that every signed-in account may read —
 * it is the chapter's promise, not anybody's personal data.
 *
 * `section` is present only for an entry that sits in a printed section (ADR-006); the
 * chapter-level fields never disappear, so a client that predates sections keeps working.
 */
function curriculumItem(
  placement: CurriculumPlacement,
  experiment: ContentExperiment,
  locale: ContentLocale,
): object {
  const node = (value: PlacementNode): object => ({
    id: value.id,
    label: value.labels[locale],
  });
  return {
    placementId: placement.placementId,
    slug: placement.slug,
    version: placement.version,
    status: placement.status,
    order: placement.order,
    experimentId: placement.experimentId,
    experimentSlug: experiment.slug,
    contentVersion: experiment.contentVersion,
    stateSchemaVersion: placement.stateSchemaVersion,
    subject: placement.subject,
    catalogId: placement.catalogId,
    bookId: placement.bookId,
    chapterId: placement.chapterId,
    ...(placement.sectionId === null
      ? {}
      : { sectionId: placement.sectionId, section: node(placement.section as PlacementNode) }),
    title: placement.title[locale],
    summary: placement.summary[locale],
    edition: node(placement.catalog),
    book: node(placement.book),
    chapter: node(placement.chapter),
    preset: { ...placement.preset },
  };
}

/**
 * One catalog with its own book/chapter/section tree (ADR-004; the tree itself became
 * subject-level content in ADR-005, sections arrived in ADR-006). Placements are referenced by
 * id only: the flat `items` array stays the single definition of each entry, so a client joins
 * the two and no entry can be described two different ways.
 *
 * A chapter lists every tool inside it — including the ones that sit in a section — so a
 * client that only knows chapters never loses an entry; each section lists its own, and the
 * page splits on the entry's `sectionId` to render each one once. A chapter or section with no
 * tool keeps its place with `placementIds: []`: "no tool published here yet" is a real state of
 * the directory, not a row to hide.
 */
function catalogTreeItem(
  catalog: CurriculumCatalog,
  placements: readonly CurriculumPlacement[],
  locale: ContentLocale,
): object {
  return {
    catalogId: catalog.catalogId,
    subject: catalog.subject,
    version: catalog.version,
    status: catalog.status,
    order: catalog.order,
    ...(catalog.editionStatus === null ? {} : { editionStatus: catalog.editionStatus }),
    label: catalog.labels[locale],
    ...(catalog.publisher === null ? {} : { publisher: catalog.publisher[locale] }),
    ...(catalog.revision === null ? {} : { revision: catalog.revision[locale] }),
    books: catalog.books.map((book) => ({
      bookId: book.bookId,
      order: book.order,
      label: book.labels[locale],
      chapters: book.chapters.map((chapter) => {
        const inChapter = placements.filter(
          (placement) =>
            placement.catalogId === catalog.catalogId &&
            placement.bookId === book.bookId &&
            placement.chapterId === chapter.chapterId,
        );
        return {
          chapterId: chapter.chapterId,
          order: chapter.order,
          label: chapter.labels[locale],
          ...(chapter.printedPage === null ? {} : { printedPage: chapter.printedPage }),
          placementIds: inChapter.map((placement) => placement.placementId),
          sections: chapter.sections.map((section) => ({
            sectionId: section.sectionId,
            order: section.order,
            label: section.labels[locale],
            ...(section.printedPage === null ? {} : { printedPage: section.printedPage }),
            placementIds: inChapter
              .filter((placement) => placement.sectionId === section.sectionId)
              .map((placement) => placement.placementId),
          })),
        };
      }),
    })),
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
    '/api/curriculum',
    { onRequest: gate.requireSession, schema: { querystring: CURRICULUM_QUERY_SCHEMA } },
    async (request, reply) => {
      accountOf(request);
      const { locale } = request.query as { locale?: ContentLocale };
      const active = locale ?? 'zh-CN';
      const items = contentIndex.placements.flatMap((placement) => {
        const experiment = contentIndex.find(placement.experimentId);
        // The index only publishes a placement whose tool is also published; a dangling
        // reference cannot be served, and startup validation already refuses one.
        return experiment === undefined ? [] : [curriculumItem(placement, experiment, active)];
      });
      return reply
        .header('cache-control', 'no-store')
        .type('application/json; charset=utf-8')
        .send({
          items,
          catalogs: contentIndex.catalogs.map((catalog) =>
            catalogTreeItem(catalog, contentIndex.placements, active),
          ),
        });
    },
  );

  app.get(
    '/api/experiments/:experimentId',
    {
      onRequest: gate.requireSession,
      schema: { params: EXPERIMENT_PARAMS_SCHEMA, querystring: EXPERIMENT_QUERY_SCHEMA },
    },
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
