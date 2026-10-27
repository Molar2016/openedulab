import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  api,
  cookieHeader,
  register,
  startAuthHarness,
  type AuthHarness,
} from './support/auth-app.js';
import {
  writeContentDir,
  writeCurriculaDir,
  type ContentFixtureEntry,
  type CurriculumCatalogFile,
} from './support/content.js';
import { CONTENT_DIR } from './helpers.js';
import { ContentIndexError, loadContentIndex } from '../src/domain/content-index.js';

/**
 * Shared subject-level catalogs (ADR-005, R9 G2).
 *
 * The textbook tree used to be declared inside one tool's `curriculum.json`, which made the
 * directory a private possession of that tool: a chapter with no tool could not exist, two
 * tools could not share a chapter, and every tool had to repeat the same book order. Here the
 * tree is a standalone content document under `curricula/<subject>/`, and a tool only owns
 * its placements. These cases pin the four properties that decoupling must keep:
 *
 * - the catalog is published even when no tool sits in it;
 * - two tools share a chapter without duplicating the directory entry;
 * - chapters without a tool stay visible (an empty chapter is a real state);
 * - two textbook versions may use the same chapter number without leaking into each other.
 *
 * Plus the failures that must still refuse to start: duplicated order and dangling
 * references, now spanning files and tools.
 */

const STATE_SCHEMA = {
  schemaVersion: 1,
  fields: {
    mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
    a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
    b: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
    c: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
  },
} as const;

interface Root {
  readonly dir: string;
  readonly contentDir: string;
}

const roots: string[] = [];
let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function chapter(
  chapterId: string,
  order: number,
  label = `Sample chapter ${chapterId}`,
): Record<string, unknown> {
  return { chapterId, order, label: { 'zh-CN': `示例章 ${chapterId}`, en: label } };
}

/** One section of a chapter: printed order, localized label, optional printed page. */
function section(
  sectionId: string,
  order: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sectionId,
    order,
    label: { 'zh-CN': `示例节 ${sectionId}`, en: `Sample section ${sectionId}` },
    ...overrides,
  };
}

/** A chapter that carries its sections (ADR-006); `sections` may be an empty array. */
function chapterWithSections(
  chapterId: string,
  order: number,
  sections: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chapterId,
    order,
    label: { 'zh-CN': `示例章 ${chapterId}`, en: `Sample chapter ${chapterId}` },
    sections: [...sections],
    ...overrides,
  };
}

function book(
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

function catalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalogId: 'pilot-edition',
    subject: 'math',
    version: 1,
    status: 'illustrative',
    order: 1,
    label: { 'zh-CN': '示例教材', en: 'Sample textbook' },
    books: [book('book-a', 1, [chapter('chapter-a', 1)])],
    ...overrides,
  };
}

function placement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

function tool(overrides: Partial<ContentFixtureEntry> = {}): ContentFixtureEntry {
  return {
    id: 'math.functions',
    slug: 'math-functions',
    titleEn: 'Functions',
    titleZh: '函数',
    stateSchema: STATE_SCHEMA as unknown as Record<string, unknown>,
    ...overrides,
  };
}

async function makeRoot(
  entries: readonly ContentFixtureEntry[],
  files: readonly CurriculumCatalogFile[] = [],
): Promise<Root> {
  const dir = await mkdtemp(path.join(tmpdir(), 'oel-shared-catalog-'));
  roots.push(dir);
  const contentDir = await writeContentDir(dir, entries);
  if (files.length > 0) await writeCurriculaDir(dir, files);
  return { dir, contentDir };
}

async function load(
  entries: readonly ContentFixtureEntry[],
  files: readonly CurriculumCatalogFile[] = [],
): Promise<
  { ok: true; index: ReturnType<typeof loadContentIndex> } | { ok: false; error: ContentIndexError }
> {
  const root = await makeRoot(entries, files);
  try {
    return { ok: true, index: loadContentIndex(root.contentDir) };
  } catch (error) {
    expect(error).toBeInstanceOf(ContentIndexError);
    return { ok: false, error: error as ContentIndexError };
  }
}

async function issuesOf(
  entries: readonly ContentFixtureEntry[],
  files: readonly CurriculumCatalogFile[] = [],
): Promise<string> {
  const result = await load(entries, files);
  if (result.ok) throw new Error('expected the content index to refuse to start');
  return result.error.issues.join('\n');
}

interface CurriculumResponse {
  items: {
    placementId: string;
    experimentId: string;
    catalogId: string;
    bookId: string;
    chapterId: string;
    sectionId?: string;
    section?: { id: string; label: string };
    order: number;
  }[];
  catalogs: {
    catalogId: string;
    subject: string;
    order: number;
    stage?: string;
    editionStatus?: string;
    publisher?: string;
    revision?: string;
    books: {
      bookId: string;
      order: number;
      chapters: {
        chapterId: string;
        order: number;
        label: string;
        printedPage?: number;
        placementIds: string[];
        sections: {
          sectionId: string;
          order: number;
          label: string;
          printedPage?: number;
          placementIds: string[];
        }[];
      }[];
    }[];
  }[];
}

async function served(root: Root): Promise<CurriculumResponse> {
  harness = await startAuthHarness({ OEL_CONTENT_DIR: root.contentDir });
  const created = await register(harness.app, { identifier: 'teacher@example.com' });
  expect(created.status).toBe(201);
  const response = await api(harness.app, {
    method: 'GET',
    url: '/api/curriculum?locale=en',
    headers: cookieHeader(created.cookie()),
  });
  expect(response.status).toBe(200);
  return response.body as unknown as CurriculumResponse;
}

describe('shared curriculum catalogs', () => {
  it('publishes a subject catalog that no tool is placed in', async () => {
    const result = await load(
      [tool()],
      [
        {
          subject: 'math',
          file: 'sample-edition',
          catalogs: [
            catalog({
              books: [
                book('book-a', 1, [chapter('chapter-a', 1), chapter('chapter-b', 2)]),
                book('book-b', 2, [chapter('chapter-c', 1)]),
              ],
            }),
          ],
        },
      ],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.catalogs.map((entry) => entry.catalogId)).toEqual(['pilot-edition']);
    expect(result.index.placements).toHaveLength(0);
    expect(result.index.catalogs[0]?.books.map((entry) => entry.bookId)).toEqual([
      'book-a',
      'book-b',
    ]);
    expect(result.index.catalogs[0]?.books[0]?.chapters.map((entry) => entry.chapterId)).toEqual([
      'chapter-a',
      'chapter-b',
    ]);
  });

  it('serves chapters without tools instead of dropping them', async () => {
    const root = await makeRoot(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [placement({ catalogId: 'pilot-edition' })],
          },
        }),
      ],
      [
        {
          subject: 'math',
          file: 'sample-edition',
          catalogs: [
            catalog({
              books: [
                book('book-a', 1, [
                  chapter('chapter-a', 1),
                  chapter('chapter-b', 2),
                  chapter('chapter-c', 3),
                ]),
              ],
            }),
          ],
        },
      ],
    );

    const body = await served(root);
    expect(body.catalogs).toHaveLength(1);
    const chapters = body.catalogs[0]?.books[0]?.chapters ?? [];
    expect(chapters.map((entry) => entry.chapterId)).toEqual([
      'chapter-a',
      'chapter-b',
      'chapter-c',
    ]);
    expect(chapters.map((entry) => entry.order)).toEqual([1, 2, 3]);
    expect(chapters[0]?.placementIds).toEqual(['math.functions.chapter-one']);
    // A chapter with no tool keeps its name and an empty tool list; nothing is invented.
    expect(chapters[1]?.placementIds).toEqual([]);
    expect(chapters[1]?.label).toBe('Sample chapter chapter-b');
    expect(body.items).toHaveLength(1);
  });

  it('lets two tools share one chapter without duplicating the directory entry', async () => {
    const root = await makeRoot(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({
                placementId: 'math.functions.shared-chapter',
                slug: 'functions-shared-chapter',
                order: 1,
              }),
            ],
          },
        }),
        tool({
          id: 'math.geometry',
          slug: 'math-geometry',
          titleEn: 'Geometry',
          titleZh: '几何',
          concepts: ['circle'],
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({
                placementId: 'math.geometry.shared-chapter',
                slug: 'geometry-shared-chapter',
                order: 2,
              }),
            ],
          },
        }),
      ],
      [
        {
          subject: 'math',
          file: 'sample-edition',
          catalogs: [catalog()],
        },
      ],
    );

    const body = await served(root);
    // One catalog, one book, one chapter — the shared chapter is not copied per tool.
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0]?.books).toHaveLength(1);
    const chapters = body.catalogs[0]?.books[0]?.chapters ?? [];
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.placementIds).toEqual([
      'math.functions.shared-chapter',
      'math.geometry.shared-chapter',
    ]);
    expect(body.items.map((item) => item.experimentId)).toEqual([
      'math.functions',
      'math.geometry',
    ]);
    expect(body.items.map((item) => item.chapterId)).toEqual(['chapter-a', 'chapter-a']);
  });

  it('keeps the same chapter number in two textbook versions isolated', async () => {
    const root = await makeRoot(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({
                placementId: 'math.functions.edition-a-chapter-19',
                slug: 'edition-a-chapter-19',
                catalogId: 'pep-2011',
                bookId: 'book-2011-8b',
                chapterId: 'chapter-2011-19',
              }),
              placement({
                placementId: 'math.functions.edition-b-chapter-19',
                slug: 'edition-b-chapter-19',
                catalogId: 'pep-2022',
                bookId: 'book-2022-8b',
                chapterId: 'chapter-2022-19',
              }),
            ],
          },
        }),
      ],
      [
        {
          subject: 'math',
          file: 'two-editions',
          catalogs: [
            catalog({
              catalogId: 'pep-2011',
              order: 1,
              books: [
                book('book-2011-8b', 1, [
                  chapter('chapter-2011-18', 1, 'Chapter 18 (2011)'),
                  chapter('chapter-2011-19', 2, 'Chapter 19: linear functions (2011)'),
                ]),
              ],
            }),
            catalog({
              catalogId: 'pep-2022',
              order: 2,
              books: [
                book('book-2022-8b', 1, [
                  chapter('chapter-2022-19', 1, 'Chapter 19: radicals (2022)'),
                  chapter('chapter-2022-20', 2, 'Chapter 20 (2022)'),
                ]),
              ],
            }),
          ],
        },
      ],
    );

    const body = await served(root);
    expect(body.catalogs.map((entry) => entry.catalogId)).toEqual(['pep-2011', 'pep-2022']);
    expect(body.catalogs[0]?.books[0]?.chapters.map((entry) => entry.chapterId)).toEqual([
      'chapter-2011-18',
      'chapter-2011-19',
    ]);
    expect(body.catalogs[1]?.books[0]?.chapters.map((entry) => entry.chapterId)).toEqual([
      'chapter-2022-19',
      'chapter-2022-20',
    ]);
    expect(body.catalogs[0]?.books[0]?.chapters[1]?.label).toBe(
      'Chapter 19: linear functions (2011)',
    );
    expect(body.catalogs[1]?.books[0]?.chapters[0]?.label).toBe('Chapter 19: radicals (2022)');
    // The two "chapter 19"s are different nodes: neither list contains the other's entry.
    expect(body.items.map((item) => item.catalogId)).toEqual(['pep-2011', 'pep-2022']);
    expect(body.items.map((item) => item.chapterId)).toEqual([
      'chapter-2011-19',
      'chapter-2022-19',
    ]);
  });

  it('refuses a placement that names a chapter from the other version', async () => {
    const issues = await issuesOf(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({
                placementId: 'math.functions.wrong-chapter',
                slug: 'wrong-chapter',
                catalogId: 'pep-2011',
                bookId: 'book-2011-8b',
                chapterId: 'chapter-2022-19',
              }),
            ],
          },
        }),
      ],
      [
        {
          subject: 'math',
          file: 'two-editions',
          catalogs: [
            catalog({
              catalogId: 'pep-2011',
              books: [book('book-2011-8b', 1, [chapter('chapter-2011-19', 1)])],
            }),
            catalog({
              catalogId: 'pep-2022',
              order: 2,
              books: [book('book-2022-8b', 1, [chapter('chapter-2022-19', 1)])],
            }),
          ],
        },
      ],
    );

    // No fuzzy fallback across versions: the chapter simply does not exist in pep-2011.
    expect(issues).toMatch(/unknown chapter "chapter-2022-19" in catalog "pep-2011"/);
  });

  it('keeps the R8 illustrative ids, slugs, versions and presets byte-identical', async () => {
    const index = loadContentIndex(CONTENT_DIR);
    const illustrative = index.placements.filter((entry) => entry.status === 'illustrative');
    expect(illustrative.map((entry) => entry.placementId)).toEqual([
      'math.functions.pilot-linear-slope',
      'math.functions.pilot-quadratic-vertex',
      'math.functions.pilot-vertex-first',
      'math.functions.pilot-slope-after',
    ]);
    expect(illustrative.map((entry) => entry.slug)).toEqual([
      'pilot-linear-slope',
      'pilot-quadratic-vertex',
      'pilot-vertex-first',
      'pilot-slope-after',
    ]);
    expect(illustrative.map((entry) => `${String(entry.version)}/${String(entry.order)}`)).toEqual([
      '1/1',
      '1/1',
      '1/1',
      '1/1',
    ]);
    expect(illustrative.map((entry) => entry.preset)).toEqual([
      { mode: 'linear', a: 2, b: 3, c: 0 },
      { mode: 'quadratic', a: 1, b: -2, c: 0 },
      { mode: 'quadratic', a: 2, b: -3, c: 0 },
      { mode: 'linear', a: -1, b: 2, c: 0 },
    ]);
    // Still four illustrative chapters in two illustrative catalogs, with their own book order.
    expect(illustrative.map((entry) => entry.catalogId)).toEqual([
      'pilot-edition',
      'pilot-edition',
      'pilot-edition-b',
      'pilot-edition-b',
    ]);
    const pilotB = index.catalogs.find((entry) => entry.catalogId === 'pilot-edition-b');
    expect(pilotB?.books.map((entry) => entry.bookId)).toEqual(['pilot-book-b1', 'pilot-book-b2']);
    // The illustrative catalogs carry no publisher or edition, and no edition line either.
    for (const catalogId of ['pilot-edition', 'pilot-edition-b']) {
      const pilot = index.catalogs.find((entry) => entry.catalogId === catalogId);
      expect(pilot?.publisher).toBeNull();
      expect(pilot?.revision).toBeNull();
      expect(pilot?.editionStatus).toBeNull();
    }
  });
});

describe('curriculum sections', () => {
  const sectionedFile = (
    chapters: readonly Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ): CurriculumCatalogFile => ({
    subject: 'math',
    file: 'sectioned-edition',
    catalogs: [catalog({ books: [book('book-a', 1, chapters)], ...overrides })],
  });

  const threeSections = chapterWithSections(
    'chapter-a',
    1,
    [section('chapter-a-s1', 1, { printedPage: 114 }), section('chapter-a-s2', 2, { printedPage: 117 }), section('chapter-a-s3', 3, { printedPage: 127 })],
    { printedPage: 113 },
  );

  it('serves the sections of a chapter in book order, with the ones that hold no tool', async () => {
    const root = await makeRoot(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [placement({ sectionId: 'chapter-a-s2' })],
          },
        }),
      ],
      [sectionedFile([threeSections, chapter('chapter-b', 2)])],
    );

    const body = await served(root);
    const chapterResponse = body.catalogs[0]?.books[0]?.chapters[0];
    expect(body.catalogs[0]?.books[0]?.chapters.map((entry) => entry.chapterId)).toEqual([
      'chapter-a',
      'chapter-b',
    ]);
    expect(chapterResponse?.printedPage).toBe(113);
    expect(chapterResponse?.sections.map((entry) => entry.sectionId)).toEqual([
      'chapter-a-s1',
      'chapter-a-s2',
      'chapter-a-s3',
    ]);
    expect(chapterResponse?.sections.map((entry) => entry.label)).toEqual([
      'Sample section chapter-a-s1',
      'Sample section chapter-a-s2',
      'Sample section chapter-a-s3',
    ]);
    expect(chapterResponse?.sections.map((entry) => entry.printedPage)).toEqual([114, 117, 127]);
    // A section nobody teaches with is still part of the book, and says so with an empty list.
    expect(chapterResponse?.sections.map((entry) => entry.placementIds)).toEqual([
      [],
      ['math.functions.chapter-one'],
      [],
    ]);
    // A chapter without sections publishes an empty list rather than omitting the key.
    expect(body.catalogs[0]?.books[0]?.chapters[1]?.sections).toEqual([]);
  });

  it('lets a placement target a section and keeps the chapter list complete', async () => {
    const root = await makeRoot(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({ sectionId: 'chapter-a-s2' }),
              placement({
                placementId: 'math.functions.chapter-two',
                slug: 'chapter-two',
                chapterId: 'chapter-b',
                order: 1,
                preset: { mode: 'quadratic', a: 1, b: -2, c: 0 },
              }),
            ],
          },
        }),
      ],
      [sectionedFile([threeSections, chapter('chapter-b', 2)])],
    );

    const body = await served(root);
    const sectioned = body.items[0];
    expect(sectioned?.chapterId).toBe('chapter-a');
    expect(sectioned?.sectionId).toBe('chapter-a-s2');
    expect(sectioned?.section).toEqual({
      id: 'chapter-a-s2',
      label: 'Sample section chapter-a-s2',
    });
    // Backward compatibility: the chapter still lists every tool inside it, so a client that
    // only knows chapters does not lose the entry.
    expect(body.catalogs[0]?.books[0]?.chapters[0]?.placementIds).toEqual([
      'math.functions.chapter-one',
    ]);
    // A chapter-level placement carries no section at all.
    expect(body.items[1]?.chapterId).toBe('chapter-b');
    expect(body.items[1]?.sectionId).toBeUndefined();
    expect(body.items[1]?.section).toBeUndefined();
  });

  it('refuses a section that belongs to another chapter, and one that does not exist', async () => {
    const unknown = await issuesOf(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [placement({ sectionId: 'chapter-b-s1' })],
          },
        }),
      ],
      [sectionedFile([threeSections, chapterWithSections('chapter-b', 2, [section('chapter-b-s1', 1)])])],
    );
    expect(unknown).toMatch(/unknown section "chapter-b-s1" in chapter "chapter-a"/);

    const missing = await issuesOf(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [placement({ sectionId: 'chapter-a-s9' })],
          },
        }),
      ],
      [sectionedFile([threeSections])],
    );
    expect(missing).toMatch(/unknown section "chapter-a-s9" in chapter "chapter-a"/);
  });

  it('refuses duplicated section ids and duplicated section order inside one chapter', async () => {
    const duplicateId = await issuesOf(
      [tool()],
      [sectionedFile([chapterWithSections('chapter-a', 1, [section('chapter-a-s1', 1), section('chapter-a-s1', 2)])])],
    );
    expect(duplicateId).toMatch(/duplicate sectionId "chapter-a-s1" in chapter "chapter-a"/);

    const duplicateOrder = await issuesOf(
      [tool()],
      [sectionedFile([chapterWithSections('chapter-a', 1, [section('chapter-a-s1', 1), section('chapter-a-s2', 1)])])],
    );
    expect(duplicateOrder).toMatch(
      /section order 1 is already used by "chapter-a-s1" in chapter "chapter-a"/,
    );
  });

  it('refuses a section that is not a positive integer step or lacks a locale', async () => {
    const badOrder = await issuesOf(
      [tool()],
      [sectionedFile([chapterWithSections('chapter-a', 1, [section('chapter-a-s1', 1, { order: 0 })])])],
    );
    expect(badOrder).toMatch(/section order must be an integer >= 1/);

    const badLabel = await issuesOf(
      [tool()],
      [
        sectionedFile([
          chapterWithSections('chapter-a', 1, [
            section('chapter-a-s1', 1, { label: { 'zh-CN': '示例节' } }),
          ]),
        ]),
      ],
    );
    expect(badLabel).toMatch(/label\.en must be a non-empty string/);

    const badPage = await issuesOf(
      [tool()],
      [sectionedFile([chapterWithSections('chapter-a', 1, [section('chapter-a-s1', 1, { printedPage: 'p117' })])])],
    );
    expect(badPage).toMatch(/printedPage must be a positive integer/);
  });

  it('treats a chapter slot and a section slot as different positions', async () => {
    const both = await load(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({ sectionId: 'chapter-a-s1' }),
              placement({
                placementId: 'math.functions.chapter-head',
                slug: 'chapter-head',
                order: 1,
                preset: { mode: 'quadratic', a: 1, b: -2, c: 0 },
              }),
            ],
          },
        }),
      ],
      [sectionedFile([threeSections])],
    );
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.index.placements).toHaveLength(2);
    expect(both.index.placements.map((entry) => entry.sectionId)).toEqual([
      null,
      'chapter-a-s1',
    ]);

    const sameSection = await issuesOf(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({ sectionId: 'chapter-a-s1' }),
              placement({
                placementId: 'math.functions.chapter-one-second-tool',
                slug: 'chapter-one-second-tool',
                order: 1,
                sectionId: 'chapter-a-s1',
                preset: { mode: 'quadratic', a: 1, b: -2, c: 0 },
              }),
            ],
          },
        }),
      ],
      [sectionedFile([threeSections])],
    );
    expect(sameSection).toMatch(
      /tool order 1 is already used by "math.functions.chapter-one" in section "chapter-a-s1"/,
    );
  });

  it('keeps a section out of one edition even when the other edition has the same number', async () => {
    const root = await makeRoot(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [
              placement({
                placementId: 'math.functions.current-23-2',
                slug: 'current-23-2',
                status: 'verified',
                catalogId: 'pep-current',
                bookId: 'book-current-8b',
                chapterId: 'chapter-current-23',
                sectionId: 'chapter-current-23-s2',
              }),
            ],
          },
        }),
      ],
      [
        {
          subject: 'math',
          file: 'two-editions-sectioned',
          catalogs: [
            catalog({
              catalogId: 'pep-current',
              order: 1,
              editionStatus: 'current-2022',
              publisher: { 'zh-CN': '人民教育出版社', en: "People's Education Press" },
              revision: { 'zh-CN': '现版', en: 'current edition' },
              status: 'verified',
              books: [
                book('book-current-8b', 1, [
                  chapterWithSections('chapter-current-23', 23, [
                    section('chapter-current-23-s1', 1),
                    section('chapter-current-23-s2', 2),
                  ]),
                ]),
              ],
            }),
            catalog({
              catalogId: 'pep-legacy',
              order: 2,
              editionStatus: 'legacy-2011',
              publisher: { 'zh-CN': '人民教育出版社', en: "People's Education Press" },
              revision: { 'zh-CN': '旧版', en: 'legacy edition' },
              status: 'verified',
              books: [
                book('book-legacy-9b', 1, [
                  chapterWithSections('chapter-legacy-26', 26, [
                    section('chapter-legacy-26-s1', 1),
                  ]),
                ]),
              ],
            }),
          ],
        },
      ],
    );

    const body = await served(root);
    expect(body.catalogs.map((entry) => entry.editionStatus)).toEqual([
      'current-2022',
      'legacy-2011',
    ]);
    expect(body.catalogs[0]?.publisher).toBe("People's Education Press");
    expect(body.items[0]?.sectionId).toBe('chapter-current-23-s2');
    // The legacy catalog's sections exist and are not reachable from the current edition.
    expect(
      body.catalogs[1]?.books[0]?.chapters[0]?.sections.map((entry) => entry.placementIds),
    ).toEqual([[]]);
  });

  it('serves the school stage a catalog declares, and omits it when the catalog has none', async () => {
    const root = await makeRoot(
      [tool()],
      [
        {
          subject: 'math',
          file: 'staged',
          catalogs: [
            catalog({ catalogId: 'pep-middle', order: 1, stage: 'middle' }),
            catalog({ catalogId: 'sample-catalog', order: 2 }),
          ],
        },
      ],
    );

    const body = await served(root);
    expect(body.catalogs.map((entry) => entry.catalogId)).toEqual(['pep-middle', 'sample-catalog']);
    // The stage is catalog metadata, served next to publisher and edition — never guessed
    // from a catalog id, a book title or a chapter number in the client.
    expect(body.catalogs[0]?.stage).toBe('middle');
    expect(Object.prototype.hasOwnProperty.call(body.catalogs[1], 'stage')).toBe(false);
  });

  it('accepts every school stage the interface can label', async () => {
    const result = await load(
      [tool()],
      [
        {
          subject: 'math',
          file: 'stages',
          catalogs: [
            catalog({ catalogId: 'pep-primary', order: 1, stage: 'primary' }),
            catalog({ catalogId: 'pep-middle', order: 2, stage: 'middle' }),
            catalog({ catalogId: 'pep-high', order: 3, stage: 'high' }),
          ],
        },
      ],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.catalogs.map((entry) => entry.stage)).toEqual([
      'primary',
      'middle',
      'high',
    ]);
  });

  it('refuses a school stage it cannot label', async () => {
    const issues = await issuesOf(
      [tool()],
      [
        {
          subject: 'math',
          file: 'staged',
          catalogs: [catalog({ stage: 'university' })],
        },
      ],
    );

    expect(issues).toMatch(/stage "university" must be one of "primary", "middle", "high"/);
  });

  it('refuses an edition status outside the known editions', async () => {
    const issues = await issuesOf(
      [tool()],
      [sectionedFile([threeSections], { editionStatus: 'new-2027' })],
    );
    expect(issues).toMatch(
      /editionStatus "new-2027" must be one of "current-2022", "legacy-2011"/,
    );
  });
});

describe('shared catalog validation', () => {
  const oneCatalog: CurriculumCatalogFile[] = [
    { subject: 'math', file: 'sample-edition', catalogs: [catalog()] },
  ];

  it('refuses two catalog files in one subject that both claim order 1', async () => {
    const issues = await issuesOf(
      [tool()],
      [
        { subject: 'math', file: 'first', catalogs: [catalog({ catalogId: 'first', order: 1 })] },
        { subject: 'math', file: 'second', catalogs: [catalog({ catalogId: 'second', order: 1 })] },
      ],
    );
    expect(issues).toMatch(/catalog order 1 is already used by "first"/);
  });

  it('refuses the same catalogId declared by two catalog files', async () => {
    const issues = await issuesOf(
      [tool()],
      [
        { subject: 'math', file: 'first', catalogs: [catalog({ order: 1 })] },
        { subject: 'math', file: 'second', catalogs: [catalog({ order: 2 })] },
      ],
    );
    expect(issues).toMatch(/duplicate catalogId "pilot-edition"/);
  });

  it('refuses a catalog file whose declared subject disagrees with its directory', async () => {
    const issues = await issuesOf(
      [tool()],
      [
        {
          subject: 'math',
          file: 'mislabelled',
          declaredSubject: 'physics',
          catalogs: [catalog({ subject: 'physics' })],
        },
      ],
    );
    expect(issues).toMatch(/subject "physics".*directory/i);
  });

  it.each([
    { label: 'unknown schemaVersion', schemaVersion: 2, pattern: /schemaVersion must be 1/ },
    { label: 'unknown schemaVersion 99', schemaVersion: 99, pattern: /schemaVersion must be 1/ },
  ])('refuses a catalog file with $label', async ({ schemaVersion, pattern }) => {
    const issues = await issuesOf(
      [tool()],
      [{ subject: 'math', file: 'sample-edition', schemaVersion, catalogs: [catalog()] }],
    );
    expect(issues).toMatch(pattern);
  });

  it('refuses a placement that names a catalog no file declares', async () => {
    const issues = await issuesOf([
      tool({
        curriculum: {
          schemaVersion: 3,
          placements: [placement({ catalogId: 'missing-edition' })],
        },
      }),
    ]);
    expect(issues).toMatch(/unknown catalog "missing-edition"/);
  });

  it('refuses a placement whose chapter lives in another book', async () => {
    const issues = await issuesOf(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [placement({ bookId: 'book-a', chapterId: 'chapter-b' })],
          },
        }),
      ],
      [
        {
          subject: 'math',
          file: 'sample-edition',
          catalogs: [
            catalog({
              books: [
                book('book-a', 1, [chapter('chapter-a', 1)]),
                book('book-b', 2, [chapter('chapter-b', 1)]),
              ],
            }),
          ],
        },
      ],
    );
    expect(issues).toMatch(/chapter "chapter-b" belongs to book "book-b", not "book-a"/);
  });

  it('refuses two tools that claim the same position inside one chapter', async () => {
    const issues = await issuesOf(
      [
        tool({
          curriculum: {
            schemaVersion: 3,
            placements: [placement({ placementId: 'math.functions.one', slug: 'one', order: 1 })],
          },
        }),
        tool({
          id: 'math.geometry',
          slug: 'math-geometry',
          titleEn: 'Geometry',
          titleZh: '几何',
          curriculum: {
            schemaVersion: 3,
            placements: [placement({ placementId: 'math.geometry.one', slug: 'two', order: 1 })],
          },
        }),
      ],
      oneCatalog,
    );
    expect(issues).toMatch(/tool order 1 is already used by "math.functions.one"/);
  });

  it('refuses a curriculum.json that still declares its own catalogs', async () => {
    const issues = await issuesOf([
      tool({
        rawCurriculum: true,
        curriculum: {
          schemaVersion: 3,
          catalogs: [catalog()],
          placements: [placement()],
        },
      }),
    ]);
    expect(issues).toMatch(/catalogs/);
    expect(issues).toMatch(/curricula\//);
  });

  it('refuses the retired schemaVersion 2 that carried catalogs inline', async () => {
    const issues = await issuesOf([
      tool({
        rawCurriculum: true,
        curriculum: {
          schemaVersion: 2,
          catalogs: [catalog()],
          placements: [placement()],
        },
      }),
    ]);
    expect(issues).toMatch(/schemaVersion must be 3/);
  });
});
