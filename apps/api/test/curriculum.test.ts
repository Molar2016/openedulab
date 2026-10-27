import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  errorCode,
  register,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';
import { writeContentDir, type ContentFixtureEntry } from './support/content.js';
import { ContentIndexError, loadContentIndex } from '../src/domain/content-index.js';

/**
 * Curriculum contexts (ADR-003).
 *
 * One tool (`math.functions`) appears in two curriculum placements. The directory is
 * protected content metadata, while a personal snapshot belongs to (account, placement) —
 * never to the tool — so a chapter can never read, overwrite or inherit another scope's
 * settings. The tool's own (account, experiment) snapshot stays exactly as R2 left it.
 */

const PLACEMENT_A = 'math.functions.pilot-linear-slope';
const PLACEMENT_B = 'math.functions.pilot-quadratic-vertex';
/** The same two conceptual chapters, declared in a second catalog with the opposite order. */
const PLACEMENT_C = 'math.functions.pilot-vertex-first';
const PLACEMENT_D = 'math.functions.pilot-slope-after';
const SLUG_C = 'pilot-vertex-first';
const SLUG_D = 'pilot-slope-after';
const CATALOG_A = 'pilot-edition';
const CATALOG_B = 'pilot-edition-b';
const TOOL = 'math.functions';

const TOOL_VALUES = { mode: 'quadratic', a: 4, b: 0, c: 0 } as const;

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

interface CurriculumItem {
  placementId?: string;
  slug?: string;
  version?: number;
  status?: string;
  order?: number;
  experimentId?: string;
  experimentSlug?: string;
  contentVersion?: string;
  stateSchemaVersion?: number;
  subject?: string;
  catalogId?: string;
  bookId?: string;
  chapterId?: string;
  title?: string;
  summary?: string;
  edition?: { id?: string; label?: string };
  book?: { id?: string; label?: string };
  chapter?: { id?: string; label?: string };
}

interface CatalogChapter {
  chapterId?: string;
  order?: number;
  label?: string;
  placementIds?: string[];
}

interface CatalogBook {
  bookId?: string;
  order?: number;
  label?: string;
  chapters?: CatalogChapter[];
}

interface Catalog {
  catalogId?: string;
  subject?: string;
  version?: number;
  status?: string;
  order?: number;
  label?: string;
  publisher?: string;
  revision?: string;
  books?: CatalogBook[];
}

interface PlacementStateBody {
  placementId?: string;
  experimentId?: string;
  placementVersion?: number;
  contentVersion?: string;
  stateSchemaVersion?: number;
  values?: Record<string, string | number>;
  updatedAt?: number;
}

interface Shaped {
  status: number;
  body: {
    items?: CurriculumItem[];
    catalogs?: Catalog[];
    values?: Record<string, string | number>;
    error?: { code?: string };
  } & PlacementStateBody;
  text: string;
  headers: Record<string, string | string[] | number | undefined>;
  code: string | undefined;
}

async function shape(response: Awaited<ReturnType<typeof api>>): Promise<Shaped> {
  return {
    status: response.status,
    body: response.body as unknown as Shaped['body'],
    text: response.text,
    headers: response.headers,
    code: errorCode(response),
  };
}

async function signedIn(identifier = 'teacher@example.com') {
  harness = await startAuthHarness();
  const created = await register(harness.app, { identifier });
  expect(created.status).toBe(201);
  return { server: harness, cookie: cookieHeader(created.cookie()) };
}

function curriculum(server: AuthHarness, cookie: Record<string, string>, query = '') {
  return api(server.app, { method: 'GET', url: `/api/curriculum${query}`, headers: cookie }).then(
    shape,
  );
}

function getPlacement(
  server: AuthHarness,
  cookie: Record<string, string>,
  placementId = PLACEMENT_A,
) {
  return api(server.app, {
    method: 'GET',
    url: `/api/me/placement-state/${placementId}`,
    headers: cookie,
  }).then(shape);
}

function putPlacement(
  server: AuthHarness,
  cookie: Record<string, string>,
  payload: unknown,
  placementId = PLACEMENT_A,
) {
  return api(server.app, {
    method: 'PUT',
    url: `/api/me/placement-state/${placementId}`,
    headers: cookie,
    payload,
  }).then(shape);
}

function placementRows(databasePath: string): {
  placement_id: string;
  experiment_id: string;
  payload: string;
  placement_version: number;
}[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare('SELECT placement_id, experiment_id, payload, placement_version FROM placement_saved_state')
      .all() as unknown as {
      placement_id: string;
      experiment_id: string;
      payload: string;
      placement_version: number;
    }[];
  } finally {
    db.close();
  }
}

function toolRows(databasePath: string): { payload: string }[] {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare('SELECT payload FROM saved_state').all() as unknown as { payload: string }[];
  } finally {
    db.close();
  }
}

function eventCount(databasePath: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('curriculum directory', () => {
  it.each([
    { method: 'GET' as const, url: '/api/curriculum' },
    { method: 'GET' as const, url: '/api/me/placement-state/math.functions.pilot-linear-slope' },
    { method: 'PUT' as const, url: '/api/me/placement-state/math.functions.pilot-linear-slope' },
  ])('$method $url denies anonymous callers', async ({ method, url }) => {
    harness = await startAuthHarness();

    const response = await api(harness.app, {
      method,
      url,
      ...(method === 'PUT'
        ? {
            payload: {
              placementVersion: 1,
              stateSchemaVersion: 1,
              values: { mode: 'linear', a: 1, b: 0, c: 0 },
            },
          }
        : {}),
    });

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });

  it('groups one tool into two illustrative catalogs, each with its own book and chapter order', async () => {
    const { server, cookie } = await signedIn();

    const listed = await curriculum(server, cookie, '?locale=en');
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');

    // The shipped directory leads with the two PEP catalogs (R9 G3); this case is about the two
    // illustrative catalogs, so it reads only their entries. Their ids, order and texts must be
    // exactly what R8 published, and they must still come after the real books.
    const allItems = listed.body.items ?? [];
    expect(allItems.slice(0, 2).map((item) => item.catalogId)).toEqual([
      'pep-math-2022',
      'pep-math-2022',
    ]);
    const items = allItems.filter((item) => item.status === 'illustrative');
    // Catalog order first, then book order, then chapter order, then the tool order inside the
    // chapter. None of it is derived from the tool id, the grade or the file order.
    expect(items.map((item) => item.placementId)).toEqual([
      PLACEMENT_A,
      PLACEMENT_B,
      PLACEMENT_C,
      PLACEMENT_D,
    ]);
    expect(items.map((item) => item.catalogId)).toEqual([
      CATALOG_A,
      CATALOG_A,
      CATALOG_B,
      CATALOG_B,
    ]);
    expect(items.map((item) => item.bookId)).toEqual([
      'pilot-book-a',
      'pilot-book-a',
      'pilot-book-b1',
      'pilot-book-b2',
    ]);

    // Same tool, one implementation — four directory positions.
    for (const item of items) {
      expect(item.experimentId).toBe(TOOL);
      expect(item.experimentSlug).toBe('math-functions');
      expect(item.contentVersion).toBe('1.0.0');
      expect(item.stateSchemaVersion).toBe(1);
      expect(item.status).toBe('illustrative');
      expect(item.subject).toBe('math');
      // The tool order inside one chapter is 1 for each entry here: the ordering that matters
      // is the catalog's, not this number.
      expect(item.order).toBe(1);
    }
    expect(items[0]?.edition?.label).toBe('Sample textbook A (not a textbook)');
    expect(items[0]?.book?.label).toBe('Sample book A');
    expect(items[0]?.chapter?.label).toBe('Sample chapter A · slope and intercept');
    expect(items[0]?.title).toBe('Slope and intercept of a linear function');
    expect(items[1]?.title).toBe('Vertex of a quadratic function');
    expect(items[2]?.edition?.label).toMatch(/not a textbook/i);
    expect(items[2]?.book?.label).toBe('Sample book B1');
    expect(items[3]?.book?.label).toBe('Sample book B2');

    const catalogs = (listed.body.catalogs ?? []).filter(
      (entry) => entry.status === 'illustrative',
    );
    expect(catalogs.map((entry) => entry.catalogId)).toEqual([CATALOG_A, CATALOG_B]);
    // Orders 3 and 4: the real textbooks own 1 and 2, examples follow them.
    expect(catalogs.map((entry) => entry.order)).toEqual([3, 4]);
    for (const catalog of catalogs) {
      expect(catalog.subject).toBe('math');
      expect(catalog.status).toBe('illustrative');
      expect(catalog.publisher).toBeUndefined();
      expect(catalog.revision).toBeUndefined();
    }
    expect(catalogs[0]?.books?.map((book) => book.bookId)).toEqual(['pilot-book-a']);
    expect(catalogs[0]?.books?.[0]?.chapters?.map((chapter) => chapter.order)).toEqual([1, 2]);
    expect(catalogs[0]?.books?.[0]?.chapters?.[0]?.placementIds).toEqual([PLACEMENT_A]);
    expect(catalogs[0]?.books?.[0]?.chapters?.[1]?.placementIds).toEqual([PLACEMENT_B]);
    expect(catalogs[1]?.books?.map((book) => book.bookId)).toEqual([
      'pilot-book-b1',
      'pilot-book-b2',
    ]);
    expect(catalogs[1]?.books?.map((book) => book.order)).toEqual([1, 2]);
    expect(catalogs[1]?.books?.[0]?.chapters?.[0]?.placementIds).toEqual([PLACEMENT_C]);
    expect(catalogs[1]?.books?.[1]?.chapters?.[0]?.placementIds).toEqual([PLACEMENT_D]);

    const zh = await curriculum(server, cookie, '?locale=zh-CN');
    const zhItems = (zh.body.items ?? []).filter((item) => item.status === 'illustrative');
    const zhCatalogs = (zh.body.catalogs ?? []).filter(
      (entry) => entry.status === 'illustrative',
    );
    expect(zhItems[0]?.title).toBe('一次函数的斜率与截距');
    expect(zhItems[0]?.chapter?.label).toBe('示例章 A · 斜率与截距');
    expect(zhCatalogs[0]?.label).toBe('示例教材甲（非教材）');
  });

  it('lets the two catalogs order the same conceptual chapters differently', async () => {
    const { server, cookie } = await signedIn();
    const listed = await curriculum(server, cookie, '?locale=en');
    const items = (listed.body.items ?? []).filter((item) => item.status === 'illustrative');
    const position = (placementId: string): number =>
      items.findIndex((item) => item.placementId === placementId);

    // Catalog A teaches slope before the vertex; catalog B teaches the vertex before slope.
    expect(position(PLACEMENT_A)).toBeLessThan(position(PLACEMENT_B));
    expect(position(PLACEMENT_C)).toBeLessThan(position(PLACEMENT_D));
    expect(position(PLACEMENT_A)).toBeLessThan(position(PLACEMENT_C));
    expect(position(PLACEMENT_D)).toBeGreaterThan(position(PLACEMENT_C));

    // Same conceptual tool, so the flat entry count is four while the tool count is one.
    expect(new Set(items.map((item) => item.experimentId))).toEqual(new Set([TOOL]));
    expect(items.map((item) => item.slug)).toEqual([
      'pilot-linear-slope',
      'pilot-quadratic-vertex',
      SLUG_C,
      SLUG_D,
    ]);
  });

  it('does not leak filesystem paths or fixture file names', async () => {
    const { server, cookie } = await signedIn();
    const listed = await curriculum(server, cookie);

    expect(listed.text).not.toMatch(/curriculum\.json|experiments[\\/]|OEL_|[A-Za-z]:\\/);
  });

  it('rejects an unknown locale instead of guessing', async () => {
    const { server, cookie } = await signedIn();
    const listed = await curriculum(server, cookie, '?locale=fr');
    expect(listed.status).toBe(400);
    expect(listed.code).toBe('validation_failed');
  });

  it('rejects malicious or malformed placement ids before any lookup', async () => {
    const { server, cookie } = await signedIn();
    const payloads = [
      '..%2f..%2faccount',
      '%2e%2e%5caccount',
      'MATH.FUNCTIONS.PILOT-LINEAR-SLOPE',
      'math.functions.',
      '.math.functions',
      'math..functions',
      'math.functions.pilot-linear-slope%00',
      'a'.repeat(200),
      'math functions',
    ];

    for (const placementId of payloads) {
      const read = await api(server.app, {
        method: 'GET',
        url: `/api/me/placement-state/${placementId}`,
        headers: cookie,
      });
      expect([400, 404]).toContain(read.status);
      expect(read.text).not.toContain('linear-slope');
      expect(read.text).not.toContain('payload');
    }

    const write = await api(server.app, {
      method: 'PUT',
      url: '/api/me/placement-state/..%2f..%2faccount',
      headers: cookie,
      payload: { placementVersion: 1, stateSchemaVersion: 1, values: { mode: 'linear', a: 1, b: 0, c: 0 } },
    });
    expect(write.status).toBe(400);
    expect(placementRows(server.databasePath)).toHaveLength(0);
  });

  it('answers 404 for a well-formed placement that is not published', async () => {
    const { server, cookie } = await signedIn();
    const unknown = 'math.functions.not-a-chapter';

    expect((await getPlacement(server, cookie, unknown)).status).toBe(404);
    const write = await putPlacement(
      server,
      cookie,
      { placementVersion: 1, stateSchemaVersion: 1, values: { mode: 'linear', a: 1, b: 0, c: 0 } },
      unknown,
    );
    expect(write.status).toBe(404);
    expect(write.code).toBe('not_found');
    expect(placementRows(server.databasePath)).toHaveLength(0);
  });
});

describe('placement-scoped saved parameters', () => {
  it('saves one snapshot per account and placement, in canonical form', async () => {
    const { server, cookie } = await signedIn();

    const before = await getPlacement(server, cookie);
    expect(before.status).toBe(404);
    expect(before.code).toBe('not_found');

    const saved = await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 4, b: -2, c: 0.5 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.placementId).toBe(PLACEMENT_A);
    expect(saved.body.experimentId).toBe(TOOL);
    expect(saved.body.placementVersion).toBe(1);
    expect(saved.body.contentVersion).toBe('1.0.0');
    expect(saved.body.stateSchemaVersion).toBe(1);
    expect(saved.body.values).toEqual({ mode: 'linear', a: 4, b: -2, c: 0.5 });
    expect(saved.headers['cache-control']).toBe('no-store');

    const rows = placementRows(server.databasePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.placement_id).toBe(PLACEMENT_A);
    expect(rows[0]?.payload).toBe('{"a":4,"b":-2,"c":0.5,"mode":"linear"}');

    const reread = await getPlacement(server, cookie);
    expect(reread.status).toBe(200);
    expect(reread.body.values).toEqual({ mode: 'linear', a: 4, b: -2, c: 0.5 });
    expect(typeof reread.body.updatedAt).toBe('number');
  });

  it('keeps two placements of the same tool apart', async () => {
    const { server, cookie } = await signedIn();

    await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 5, b: 1, c: 0 },
    });

    const other = await getPlacement(server, cookie, PLACEMENT_B);
    expect(other.status).toBe(404);

    await putPlacement(
      server,
      cookie,
      { placementVersion: 1, stateSchemaVersion: 1, values: { mode: 'quadratic', a: -3, b: 0, c: 1 } },
      PLACEMENT_B,
    );

    const first = await getPlacement(server, cookie, PLACEMENT_A);
    const second = await getPlacement(server, cookie, PLACEMENT_B);
    expect(first.body.values).toEqual({ mode: 'linear', a: 5, b: 1, c: 0 });
    expect(second.body.values).toEqual({ mode: 'quadratic', a: -3, b: 0, c: 1 });
    expect(placementRows(server.databasePath)).toHaveLength(2);
  });

  it('never copies a snapshot between two catalogs that place the same tool', async () => {
    const { server, cookie } = await signedIn();

    await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 5, b: 1, c: 0 },
    });
    await putPlacement(
      server,
      cookie,
      { placementVersion: 1, stateSchemaVersion: 1, values: { mode: 'linear', a: -4, b: 2, c: 0 } },
      PLACEMENT_D,
    );

    const first = await getPlacement(server, cookie, PLACEMENT_A);
    const reordered = await getPlacement(server, cookie, PLACEMENT_D);
    expect(first.body.values).toEqual({ mode: 'linear', a: 5, b: 1, c: 0 });
    expect(reordered.body.values).toEqual({ mode: 'linear', a: -4, b: 2, c: 0 });
    expect((await getPlacement(server, cookie, PLACEMENT_C)).status).toBe(404);
    expect(placementRows(server.databasePath)).toHaveLength(2);
  });

  it('never copies between the chapter scope and the tool scope', async () => {
    const { server, cookie } = await signedIn();

    // A tool-level snapshot written through the R2 route.
    const toolSaved = await api(server.app, {
      method: 'PUT',
      url: `/api/me/saved-state/${TOOL}`,
      headers: cookie,
      payload: { stateSchemaVersion: 1, values: TOOL_VALUES },
    });
    expect(toolSaved.status).toBe(200);

    // The chapter has nothing yet: the tool snapshot is not inherited.
    const chapterBefore = await getPlacement(server, cookie);
    expect(chapterBefore.status).toBe(404);

    await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 6, b: 2, c: 0 },
    });

    // And the tool snapshot is untouched by the chapter write.
    const toolRead = await api(server.app, {
      method: 'GET',
      url: `/api/me/saved-state/${TOOL}`,
      headers: cookie,
    });
    expect(toolRead.status).toBe(200);
    expect((toolRead.body as { values?: unknown }).values).toEqual(TOOL_VALUES);
    expect(toolRows(server.databasePath)).toHaveLength(1);
    expect(placementRows(server.databasePath)).toHaveLength(1);
  });

  it('is invisible to another account, which cannot overwrite it', async () => {
    harness = await startAuthHarness();
    const owner = await register(harness.app, { identifier: 'owner@example.com' });
    const other = await register(harness.app, { identifier: 'other@example.com' });
    expect(owner.status).toBe(201);
    expect(other.status).toBe(201);
    const ownerCookie = cookieHeader(owner.cookie());
    const otherCookie = cookieHeader(other.cookie());

    await putPlacement(harness, ownerCookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 7, b: 0, c: 0 },
    });

    const otherRead = await getPlacement(harness, otherCookie);
    expect(otherRead.status).toBe(404);
    expect(otherRead.text).not.toContain('linear');

    const otherWrite = await putPlacement(harness, otherCookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: -7, b: 0, c: 0 },
    });
    expect(otherWrite.status).toBe(200);

    const ownerRead = await getPlacement(harness, ownerCookie);
    expect(ownerRead.body.values).toEqual({ mode: 'linear', a: 7, b: 0, c: 0 });
    expect(placementRows(harness.databasePath)).toHaveLength(2);
  });

  it('refuses a stale placement version and a stale state-schema version', async () => {
    const { server, cookie } = await signedIn();
    const values = { mode: 'linear', a: 1, b: 0, c: 0 };

    const stalePlacement = await putPlacement(server, cookie, {
      placementVersion: 2,
      stateSchemaVersion: 1,
      values,
    });
    expect(stalePlacement.status).toBe(409);
    expect(stalePlacement.code).toBe('state_schema_incompatible');

    const staleSchema = await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 2,
      values,
    });
    expect(staleSchema.status).toBe(409);
    expect(staleSchema.code).toBe('state_schema_incompatible');

    // A string version is a client bug, not something to coerce (AJV would do that).
    const stringy = await putPlacement(server, cookie, {
      placementVersion: '1',
      stateSchemaVersion: 1,
      values,
    });
    expect(stringy.status).toBe(400);

    expect(placementRows(server.databasePath)).toHaveLength(0);
  });

  it('rejects values the tool schema does not allow', async () => {
    const { server, cookie } = await signedIn();
    const cases = [
      { values: { mode: 'linear', a: 1, b: 0 }, reason: 'missing_key' },
      { values: { mode: 'linear', a: 1, b: 0, c: 0, d: 1 }, reason: 'unknown_key' },
      { values: { mode: 'cubic', a: 1, b: 0, c: 0 }, reason: 'invalid_enum' },
      { values: { mode: 'linear', a: 99, b: 0, c: 0 }, reason: 'out_of_range' },
      { values: { mode: 'linear', a: 0.05, b: 0, c: 0 }, reason: 'off_step' },
      { values: { mode: 'linear', a: '2', b: 0, c: 0 }, reason: 'invalid_number' },
    ];

    for (const testCase of cases) {
      const response = await putPlacement(server, cookie, {
        placementVersion: 1,
        stateSchemaVersion: 1,
        values: testCase.values,
      });
      expect(response.status, testCase.reason).toBe(400);
      expect(response.code).toBe('state_invalid');
    }
    expect(placementRows(server.databasePath)).toHaveLength(0);
  });

  it('never writes parameter values into the diagnostics table', async () => {
    const { server, cookie } = await signedIn();
    const before = eventCount(server.databasePath);

    await putPlacement(server, cookie, {
      placementVersion: 1,
      stateSchemaVersion: 1,
      values: { mode: 'linear', a: 3, b: 0, c: 0 },
    });
    await getPlacement(server, cookie);

    expect(eventCount(server.databasePath)).toBe(before);
  });
});

describe('curriculum catalog content validation', () => {
  const stateSchema = {
    schemaVersion: 1,
    fields: {
      mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
      a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
      b: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
      c: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
    },
  };

  function chapterNode(chapterId: string, order: number): Record<string, unknown> {
    return {
      chapterId,
      order,
      label: { 'zh-CN': `示例章 ${chapterId}`, en: `Sample chapter ${chapterId}` },
    };
  }

  function bookNode(
    bookId: string,
    order: number,
    chapters: readonly Record<string, unknown>[],
  ): Record<string, unknown> {
    return {
      bookId,
      order,
      label: { 'zh-CN': `示例册 ${bookId}`, en: `Sample book ${bookId}` },
      chapters: [...chapters],
    };
  }

  const catalog = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    catalogId: 'pilot-edition',
    subject: 'math',
    version: 1,
    status: 'illustrative',
    order: 1,
    label: { 'zh-CN': '示例教材', en: 'Sample textbook' },
    books: [bookNode('book-a', 1, [chapterNode('chapter-a', 1)])],
    ...overrides,
  });

  const placement = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    placementId: 'math.functions.chapter-one',
    slug: 'chapter-one',
    version: 1,
    status: 'illustrative',
    catalogId: 'pilot-edition',
    bookId: 'book-a',
    chapterId: 'chapter-a',
    order: 1,
    title: { 'zh-CN': '示例标题', en: 'Sample title' },
    summary: { 'zh-CN': '示例说明', en: 'Sample summary' },
    preset: { mode: 'linear', a: 2, b: 3, c: 0 },
    ...overrides,
  });

  async function loadWith(
    entries: readonly ContentFixtureEntry[],
  ): Promise<
    { ok: true; index: ReturnType<typeof loadContentIndex> } | { ok: false; error: ContentIndexError }
  > {
    const root = await mkdtemp(path.join(tmpdir(), 'oel-curriculum-'));
    try {
      const contentDir = await writeContentDir(root, entries);
      try {
        return { ok: true, index: loadContentIndex(contentDir) };
      } catch (error) {
        return { ok: false, error: error as ContentIndexError };
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const base: ContentFixtureEntry = {
    id: 'math.functions',
    slug: 'math-functions',
    titleEn: 'Functions',
    titleZh: '函数',
    stateSchema,
  };

  it('orders placements by catalog, book and chapter order, not by tool or file order', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [
            catalog({
              books: [
                bookNode('book-a', 1, [chapterNode('chapter-a', 1), chapterNode('chapter-b', 2)]),
              ],
            }),
            catalog({
              catalogId: 'pilot-edition-b',
              order: 2,
              books: [
                bookNode('book-b1', 1, [chapterNode('chapter-x', 1)]),
                bookNode('book-b2', 2, [chapterNode('chapter-y', 1)]),
              ],
            }),
          ],
          placements: [
            placement({
              placementId: 'math.functions.one',
              slug: 'one',
              bookId: 'book-a',
              chapterId: 'chapter-a',
            }),
            placement({
              placementId: 'math.functions.two',
              slug: 'two',
              bookId: 'book-a',
              chapterId: 'chapter-b',
            }),
            placement({
              placementId: 'math.functions.three',
              slug: 'three',
              catalogId: 'pilot-edition-b',
              bookId: 'book-b1',
              chapterId: 'chapter-x',
            }),
            placement({
              placementId: 'math.functions.four',
              slug: 'four',
              catalogId: 'pilot-edition-b',
              bookId: 'book-b2',
              chapterId: 'chapter-y',
            }),
          ],
        },
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.catalogs.map((entry) => entry.catalogId)).toEqual([
      'pilot-edition',
      'pilot-edition-b',
    ]);
    expect(result.index.placements.map((entry) => entry.placementId)).toEqual([
      'math.functions.one',
      'math.functions.two',
      'math.functions.three',
      'math.functions.four',
    ]);
    expect(result.index.placements[2]?.catalogId).toBe('pilot-edition-b');
    expect(result.index.placements[2]?.catalog.labels.en).toBe('Sample textbook');
    expect(result.index.placements[2]?.book.labels.en).toBe('Sample book book-b1');
  });

  it('refuses a duplicate catalog id inside one file', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [catalog(), catalog({ order: 2 })],
          placements: [placement()],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/duplicate catalogId/i);
  });

  it('refuses the same catalog id declared by another tool folder', async () => {
    const result = await loadWith([
      { ...base, curriculum: { schemaVersion: 2, catalogs: [catalog()], placements: [] } },
      {
        id: 'physics.freefall',
        slug: 'physics-freefall',
        titleEn: 'Free fall',
        titleZh: '自由落体',
        subjects: ['physics'],
        curriculum: {
          schemaVersion: 2,
          catalogs: [
            catalog({
              subject: 'physics',
              books: [bookNode('book-a', 1, [chapterNode('chapter-a', 1)])],
            }),
          ],
          placements: [],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/duplicate catalogId/i);
  });

  it('resolves a placement against a catalog declared in another tool folder (ADR-005)', async () => {
    // The tree is subject-level content now, so a second math tool may point into the same
    // catalog. This used to be a hard error under ADR-004 ("declare it in your own file");
    // that rule is exactly what forced every tool to duplicate the textbook tree.
    const result = await loadWith([
      { ...base, curriculum: { schemaVersion: 2, catalogs: [catalog()], placements: [] } },
      {
        id: 'math.geometry',
        slug: 'math-geometry',
        titleEn: 'Circle and chord',
        titleZh: '圆与弦',
        subjects: ['math'],
        stateSchema,
        curriculum: {
          schemaVersion: 3,
          placements: [
            placement({
              placementId: 'math.geometry.one',
              slug: 'geometry-one',
              order: 2,
            }),
          ],
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.placements.map((entry) => entry.placementId)).toEqual([
      'math.geometry.one',
    ]);
    expect(result.index.placements[0]?.catalog.labels.en).toBe('Sample textbook');
  });

  it('refuses a placement whose catalog no catalog file declares', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 3,
          placements: [placement({ catalogId: 'pilot-edition' })],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/unknown catalog "pilot-edition"/i);
  });

  it('refuses a chapter that lives under another book instead of matching it by name', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [
            catalog({
              books: [
                bookNode('book-a', 1, [chapterNode('chapter-a', 1)]),
                bookNode('book-b', 2, [chapterNode('chapter-b', 1)]),
              ],
            }),
          ],
          placements: [placement({ bookId: 'book-a', chapterId: 'chapter-b' })],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(
      /chapter "chapter-b" belongs to book "book-b", not "book-a"/i,
    );
  });

  it.each([
    {
      label: 'duplicate chapter ids across books',
      catalogs: [
        catalog({
          books: [
            bookNode('book-a', 1, [chapterNode('chapter-a', 1)]),
            bookNode('book-b', 2, [chapterNode('chapter-a', 1)]),
          ],
        }),
      ],
      placements: [],
      pattern: /duplicate chapterId/i,
    },
    {
      label: 'duplicate book ids',
      catalogs: [
        catalog({
          books: [
            bookNode('book-a', 1, [chapterNode('chapter-a', 1)]),
            bookNode('book-a', 2, [chapterNode('chapter-b', 1)]),
          ],
        }),
      ],
      placements: [],
      pattern: /duplicate bookId/i,
    },
    {
      label: 'duplicate book order',
      catalogs: [
        catalog({
          books: [
            bookNode('book-a', 1, [chapterNode('chapter-a', 1)]),
            bookNode('book-b', 1, [chapterNode('chapter-b', 1)]),
          ],
        }),
      ],
      placements: [],
      pattern: /book order 1 is already used/i,
    },
    {
      label: 'duplicate chapter order inside one book',
      catalogs: [
        catalog({
          books: [
            bookNode('book-a', 1, [chapterNode('chapter-a', 1), chapterNode('chapter-b', 1)]),
          ],
        }),
      ],
      placements: [],
      pattern: /chapter order 1 is already used/i,
    },
    {
      label: 'non-integer book order',
      catalogs: [catalog({ books: [bookNode('book-a', 1.5, [chapterNode('chapter-a', 1)])] })],
      placements: [],
      pattern: /book order must be an integer/i,
    },
    {
      label: 'zero chapter order',
      catalogs: [catalog({ books: [bookNode('book-a', 1, [chapterNode('chapter-a', 0)])] })],
      placements: [],
      pattern: /chapter order must be an integer/i,
    },
    {
      label: 'duplicate catalog order',
      catalogs: [catalog(), catalog({ catalogId: 'second', order: 1 })],
      placements: [],
      pattern: /catalog order 1 is already used/i,
    },
  ])('refuses $label', async ({ catalogs, placements, pattern }) => {
    const result = await loadWith([
      { ...base, curriculum: { schemaVersion: 2, catalogs, placements } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(pattern);
  });

  it('refuses two placements at the same position inside one chapter', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [catalog()],
          placements: [
            placement(),
            placement({ placementId: 'math.functions.chapter-two', slug: 'chapter-two', order: 1 }),
          ],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/tool order 1 is already used/i);
  });

  it('refuses a placement whose status disagrees with its catalog', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [catalog()],
          placements: [placement({ status: 'verified' })],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/status.*catalog/i);
  });

  it('refuses a verified catalog without publisher and edition, and an illustrative one with them', async () => {
    const verifiedWithout = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [catalog({ status: 'verified' })],
          placements: [placement({ status: 'verified' })],
        },
      },
    ]);
    expect(verifiedWithout.ok).toBe(false);
    if (verifiedWithout.ok) return;
    expect(verifiedWithout.error.issues.join('\n')).toMatch(/publisher/i);
    expect(verifiedWithout.error.issues.join('\n')).toMatch(/revision/i);

    const illustrativeWith = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [
            catalog({
              publisher: { 'zh-CN': '某出版社', en: 'Some publisher' },
              revision: { 'zh-CN': '第一版', en: 'First edition' },
            }),
          ],
          placements: [placement()],
        },
      },
    ]);
    expect(illustrativeWith.ok).toBe(false);
    if (illustrativeWith.ok) return;
    expect(illustrativeWith.error.issues.join('\n')).toMatch(/illustrative/i);
  });

  it('refuses a catalog whose subject is not one of the tool subjects', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [catalog({ subject: 'physics' })],
          placements: [placement()],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/subject "physics"/i);
  });

  it('refuses the old flat schema version', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 1,
          placements: [
            {
              ...placement(),
              edition: { id: 'pilot-edition', labels: { 'zh-CN': '试点版', en: 'Pilot edition' } },
              book: { id: 'book-a', labels: { 'zh-CN': '示例册', en: 'Sample book' } },
              chapter: { id: 'chapter-a', labels: { 'zh-CN': '示例章', en: 'Sample chapter' } },
            },
          ],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/schemaVersion must be 3/i);
  });

  it('refuses a preset that the tool schema rejects', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: {
          schemaVersion: 2,
          catalogs: [catalog()],
          placements: [placement({ preset: { mode: 'cubic', a: 1, b: 0, c: 0 } })],
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/preset/i);
  });

  it('refuses a placement for a tool without a state schema', async () => {
    const result = await loadWith([
      {
        ...base,
        stateSchema: undefined,
        curriculum: { schemaVersion: 2, catalogs: [catalog()], placements: [placement()] },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/state-schema\.json/);
  });

  it.each([
    { label: 'unknown schema version', curriculum: { schemaVersion: 4, placements: [] } },
    {
      label: 'unknown status',
      curriculum: {
        schemaVersion: 2,
        catalogs: [catalog({ status: 'official' })],
        placements: [],
      },
    },
    {
      label: 'bad placement id',
      curriculum: {
        schemaVersion: 2,
        catalogs: [catalog()],
        placements: [placement({ placementId: 'Chapter One' })],
      },
    },
    {
      label: 'empty chapter label',
      curriculum: {
        schemaVersion: 2,
        catalogs: [
          catalog({
            books: [
              {
                bookId: 'book-a',
                order: 1,
                label: { 'zh-CN': '示例册', en: 'Sample book' },
                chapters: [
                  {
                    chapterId: 'chapter-a',
                    order: 1,
                    label: { 'zh-CN': '', en: 'x' },
                  },
                ],
              },
            ],
          }),
        ],
        placements: [],
      },
    },
    {
      label: 'missing summary locale',
      curriculum: {
        schemaVersion: 2,
        catalogs: [catalog()],
        placements: [placement({ summary: { en: 'only english' } })],
      },
    },
    {
      label: 'non-integer tool order',
      curriculum: {
        schemaVersion: 2,
        catalogs: [catalog()],
        placements: [placement({ order: 1.5 })],
      },
    },
    {
      label: 'extra top-level key',
      curriculum: { schemaVersion: 2, catalogs: [], placements: [], textbook: 'x' },
    },
  ])('refuses $label', async ({ curriculum }) => {
    const result = await loadWith([{ ...base, curriculum }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it('refuses duplicate placement slugs across experiments (URLs must be unique)', async () => {
    const result = await loadWith([
      {
        ...base,
        curriculum: { schemaVersion: 2, catalogs: [catalog()], placements: [placement()] },
      },
      {
        id: 'physics.freefall',
        slug: 'physics-freefall',
        titleEn: 'Free fall',
        titleZh: '自由落体',
        subjects: ['physics'],
        stateSchema,
        curriculum: {
          schemaVersion: 2,
          catalogs: [
            catalog({ catalogId: 'physics-edition', subject: 'physics' }),
          ],
          placements: [
            placement({
              placementId: 'physics.freefall.chapter-one',
              catalogId: 'physics-edition',
            }),
          ],
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.join('\n')).toMatch(/duplicate.*slug/i);
  });
});
