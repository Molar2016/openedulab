import { describe, expect, it } from 'vitest';

import { buildCurriculumTree } from '../apps/web/src/app/curriculum-tree';
import type { CurriculumCatalog, CurriculumItem } from '../apps/web/src/services/api';

/**
 * Curriculum navigation is 学科 → 教材（版本） → 册 → 章 → 工具入口.
 *
 * The order of every level is a property of the catalog (its own `order` numbers), never of
 * the tool id, the grade or the array position in the response. The same tool can appear in
 * two catalogs, and those catalogs are allowed to order the same conceptual chapters
 * differently — the tree must preserve each catalog's own order.
 */

function item(
  placementId: string,
  slug: string,
  catalogId: string,
  bookId: string,
  chapterId: string,
  order: number,
): CurriculumItem {
  return {
    placementId,
    slug,
    version: 1,
    status: 'illustrative',
    order,
    experimentId: 'math.functions',
    experimentSlug: 'math-functions',
    contentVersion: '1.0.0',
    stateSchemaVersion: 1,
    subject: 'math',
    catalogId,
    bookId,
    chapterId,
    title: `Title ${slug}`,
    summary: `Summary ${slug}`,
    edition: { id: catalogId, label: `Catalog ${catalogId}` },
    book: { id: bookId, label: `Book ${bookId}` },
    chapter: { id: chapterId, label: `Chapter ${chapterId}` },
    preset: { mode: 'linear', a: 1, b: 0, c: 0 },
  };
}

const CATALOG_A: CurriculumCatalog = {
  catalogId: 'pilot-edition',
  subject: 'math',
  version: 1,
  status: 'illustrative',
  order: 1,
  label: 'Sample textbook A (not a textbook)',
  books: [
    {
      bookId: 'pilot-book-a',
      order: 1,
      label: 'Sample book A',
      chapters: [
        { chapterId: 'pilot-chapter-a', order: 2, label: 'Chapter A2', placementIds: ['a'] },
        { chapterId: 'pilot-chapter-b', order: 1, label: 'Chapter A1', placementIds: ['b'] },
      ],
    },
  ],
};

const CATALOG_B: CurriculumCatalog = {
  catalogId: 'pilot-edition-b',
  subject: 'math',
  version: 1,
  status: 'illustrative',
  order: 2,
  label: 'Sample textbook B (not a textbook)',
  books: [
    {
      bookId: 'pilot-book-b2',
      order: 2,
      label: 'Sample book B2',
      chapters: [
        { chapterId: 'pilot-chapter-b2-slope', order: 1, label: 'Slope', placementIds: ['d'] },
      ],
    },
    {
      bookId: 'pilot-book-b1',
      order: 1,
      label: 'Sample book B1',
      chapters: [
        { chapterId: 'pilot-chapter-b1-vertex', order: 1, label: 'Vertex', placementIds: ['c'] },
      ],
    },
  ],
};

const ITEMS: readonly CurriculumItem[] = [
  item('a', 'pilot-linear-slope', 'pilot-edition', 'pilot-book-a', 'pilot-chapter-a', 1),
  item('b', 'pilot-quadratic-vertex', 'pilot-edition', 'pilot-book-a', 'pilot-chapter-b', 1),
  item('c', 'pilot-vertex-first', 'pilot-edition-b', 'pilot-book-b1', 'pilot-chapter-b1-vertex', 1),
  item('d', 'pilot-slope-after', 'pilot-edition-b', 'pilot-book-b2', 'pilot-chapter-b2-slope', 1),
];

describe('curriculum tree', () => {
  it('groups subject → catalog → book → chapter, using the explicit order of each level', () => {
    const tree = buildCurriculumTree(ITEMS, [CATALOG_B, CATALOG_A]);

    expect(tree.map((group) => group.subject)).toEqual(['math']);
    const catalogs = tree[0]?.catalogs ?? [];
    expect(catalogs.map((group) => group.catalog.catalogId)).toEqual([
      'pilot-edition',
      'pilot-edition-b',
    ]);

    const booksA = catalogs[0]?.books ?? [];
    expect(booksA.map((group) => group.book.bookId)).toEqual(['pilot-book-a']);
    // chapter order 1 comes before chapter order 2, whatever the array says.
    expect(booksA[0]?.chapters.map((group) => group.chapter.chapterId)).toEqual([
      'pilot-chapter-b',
      'pilot-chapter-a',
    ]);
    expect(booksA[0]?.chapters[1]?.entries.map((entry) => entry.placementId)).toEqual(['a']);

    const booksB = catalogs[1]?.books ?? [];
    expect(booksB.map((group) => group.book.bookId)).toEqual(['pilot-book-b1', 'pilot-book-b2']);
    expect(booksB[0]?.chapters[0]?.entries.map((entry) => entry.slug)).toEqual([
      'pilot-vertex-first',
    ]);
    expect(booksB[1]?.chapters[0]?.entries.map((entry) => entry.slug)).toEqual([
      'pilot-slope-after',
    ]);
  });

  it('keeps the same tool in two catalogs, ordered differently by each catalog', () => {
    const tree = buildCurriculumTree(ITEMS, [CATALOG_A, CATALOG_B]);
    const [catalogA, catalogB] = tree[0]?.catalogs ?? [];

    const orderInA = (catalogA?.books ?? []).flatMap((book) =>
      book.chapters.flatMap((chapter) => chapter.entries.map((entry) => entry.slug)),
    );
    const orderInB = (catalogB?.books ?? []).flatMap((book) =>
      book.chapters.flatMap((chapter) => chapter.entries.map((entry) => entry.slug)),
    );

    // Both catalogs use the same tool; only the catalog decides which chapter comes first.
    expect(new Set([...orderInA, ...orderInB].map((slug) => slug))).toEqual(
      new Set(['pilot-linear-slope', 'pilot-quadratic-vertex', 'pilot-vertex-first', 'pilot-slope-after']),
    );
    expect(orderInA).toEqual(['pilot-quadratic-vertex', 'pilot-linear-slope']);
    expect(orderInB).toEqual(['pilot-vertex-first', 'pilot-slope-after']);
  });

  it('orders the tools inside a chapter by their own order, not by the array position', () => {
    const catalog: CurriculumCatalog = {
      ...CATALOG_A,
      books: [
        {
          bookId: 'pilot-book-a',
          order: 1,
          label: 'Sample book A',
          chapters: [
            {
              chapterId: 'pilot-chapter-a',
              order: 1,
              label: 'Chapter A',
              placementIds: ['b', 'a'],
            },
          ],
        },
      ],
    };
    const tree = buildCurriculumTree(
      [item('b', 'second', 'pilot-edition', 'pilot-book-a', 'pilot-chapter-a', 2),
       item('a', 'first', 'pilot-edition', 'pilot-book-a', 'pilot-chapter-a', 1)],
      [catalog],
    );

    expect(
      tree[0]?.catalogs[0]?.books[0]?.chapters[0]?.entries.map((entry) => entry.slug),
    ).toEqual(['first', 'second']);
  });

  it('drops references that no longer resolve instead of rendering half a catalog', () => {
    const catalog: CurriculumCatalog = {
      ...CATALOG_A,
      books: [
        {
          bookId: 'pilot-book-a',
          order: 1,
          label: 'Sample book A',
          chapters: [
            {
              chapterId: 'pilot-chapter-a',
              order: 1,
              label: 'Chapter A',
              placementIds: ['a', 'not-published'],
            },
            {
              chapterId: 'pilot-chapter-b',
              order: 2,
              label: 'Chapter B',
              placementIds: ['stale'],
            },
          ],
        },
      ],
    };
    const tree = buildCurriculumTree([ITEMS[0] as CurriculumItem], [catalog]);
    const chapters = tree[0]?.catalogs[0]?.books[0]?.chapters ?? [];

    expect(chapters[0]?.entries.map((entry) => entry.placementId)).toEqual(['a']);
    expect(chapters[1]?.entries).toEqual([]);
  });

  it('groups catalogs of different subjects separately, in catalog order within each subject', () => {
    const physicsCatalog: CurriculumCatalog = {
      catalogId: 'physics-edition',
      subject: 'physics',
      version: 1,
      status: 'illustrative',
      order: 1,
      label: 'Sample physics catalog (not a textbook)',
      books: [],
    };
    const tree = buildCurriculumTree([ITEMS[0] as CurriculumItem], [physicsCatalog, CATALOG_A]);

    expect(tree.map((group) => group.subject)).toEqual(['math', 'physics']);
    expect(tree[0]?.catalogs.map((group) => group.catalog.catalogId)).toEqual(['pilot-edition']);
    expect(tree[1]?.catalogs.map((group) => group.catalog.catalogId)).toEqual(['physics-edition']);
  });

  it('returns nothing to browse when the server publishes no catalog', () => {
    expect(buildCurriculumTree([ITEMS[0] as CurriculumItem], [])).toEqual([]);
  });
});

/**
 * Sections (ADR-006): a chapter may now hang sections under it, and a tool entry may sit in
 * one of them. The tree must place each entry exactly once: a chapter lists every tool inside
 * it (so a chapter-only client loses nothing), while a section lists only its own — so the
 * page has to split on the entry's own section id instead of rendering both lists blindly.
 */
const SECTION_CATALOG: CurriculumCatalog = {
  catalogId: 'pep-math-2022',
  subject: 'math',
  version: 1,
  status: 'verified',
  order: 1,
  editionStatus: 'current-2022',
  label: 'PEP current edition',
  books: [
    {
      bookId: 'pep-math-8b-2026',
      order: 1,
      label: 'Grade 8, volume 2',
      chapters: [
        {
          chapterId: 'pep-math-8b-2026-ch23',
          order: 23,
          label: 'Chapter 23 Linear functions',
          printedPage: 113,
          placementIds: ['linear', 'chapter-head'],
          sections: [
            {
              sectionId: 'pep-math-8b-2026-ch23-s1',
              order: 1,
              label: '23.1 The concept of a linear function',
              printedPage: 114,
              placementIds: [],
            },
            {
              sectionId: 'pep-math-8b-2026-ch23-s2',
              order: 2,
              label: '23.2 Graphs and properties of linear functions',
              printedPage: 117,
              placementIds: ['linear'],
            },
          ],
        },
      ],
    },
  ],
};

function sectionItem(placementId: string, sectionId: string | undefined): CurriculumItem {
  const base = item(placementId, `slug-${placementId}`, 'pep-math-2022', 'pep-math-8b-2026', 'pep-math-8b-2026-ch23', 1);
  return sectionId === undefined
    ? base
    : { ...base, sectionId, section: { id: sectionId, label: `Section ${sectionId}` } };
}

describe('curriculum tree with sections', () => {
  it('keeps each section in order and splits entries between the chapter and its sections', () => {
    const tree = buildCurriculumTree(
      [
        sectionItem('linear', 'pep-math-8b-2026-ch23-s2'),
        sectionItem('chapter-head', undefined),
      ],
      [SECTION_CATALOG],
    );
    const chapter = tree[0]?.catalogs[0]?.books[0]?.chapters[0];

    // The chapter keeps only the entries that sit on the chapter itself.
    expect(chapter?.entries.map((entry) => entry.placementId)).toEqual(['chapter-head']);
    expect(chapter?.sections.map((group) => group.section.sectionId)).toEqual([
      'pep-math-8b-2026-ch23-s1',
      'pep-math-8b-2026-ch23-s2',
    ]);
    // An empty section stays visible with no entries, in book order.
    expect(chapter?.sections[0]?.entries).toEqual([]);
    expect(chapter?.sections[1]?.entries.map((entry) => entry.placementId)).toEqual(['linear']);
    expect(chapter?.chapter.printedPage).toBe(113);
    expect(chapter?.sections[1]?.section.printedPage).toBe(117);
  });

  it('renders every entry exactly once even though the chapter lists its sections too', () => {
    const tree = buildCurriculumTree(
      [
        sectionItem('linear', 'pep-math-8b-2026-ch23-s2'),
        sectionItem('chapter-head', undefined),
      ],
      [SECTION_CATALOG],
    );
    const chapter = tree[0]?.catalogs[0]?.books[0]?.chapters[0];
    const seen = [
      ...(chapter?.entries ?? []).map((entry) => entry.placementId),
      ...(chapter?.sections ?? []).flatMap((group) =>
        group.entries.map((entry) => entry.placementId),
      ),
    ];

    expect(seen.sort()).toEqual(['chapter-head', 'linear']);
    // The chapter's own list is a superset (compatibility); the sections partition it.
    expect(SECTION_CATALOG.books[0]?.chapters[0]?.placementIds).toEqual(['linear', 'chapter-head']);
  });

  it('drops a section entry whose id resolves to no published item, keeping the section', () => {
    const tree = buildCurriculumTree([sectionItem('chapter-head', undefined)], [SECTION_CATALOG]);
    const chapter = tree[0]?.catalogs[0]?.books[0]?.chapters[0];

    expect(chapter?.sections).toHaveLength(2);
    expect(chapter?.sections[1]?.entries).toEqual([]);
    expect(chapter?.entries.map((entry) => entry.placementId)).toEqual(['chapter-head']);
  });

  it('shows a chapter without any section (R8 catalogs) exactly as before', () => {
    const tree = buildCurriculumTree(ITEMS, [CATALOG_A]);
    const chapters = tree[0]?.catalogs[0]?.books[0]?.chapters ?? [];

    expect(chapters.map((group) => group.sections)).toEqual([[], []]);
    expect(chapters[1]?.entries.map((entry) => entry.placementId)).toEqual(['a']);
  });
});
