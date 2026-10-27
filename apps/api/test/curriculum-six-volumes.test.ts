import { afterEach, describe, expect, it } from 'vitest';

import { api, cookieHeader, register, startAuthHarness, type AuthHarness } from './support/auth-app.js';
import { CONTENT_DIR } from './helpers.js';
import { loadContentIndex } from '../src/domain/content-index.js';

/**
 * The shipped six-volume directory (R9 G3, ADR-006).
 *
 * These cases read the real `curricula/` tree — not a fixture — because the point of G3 is
 * the data: every chapter and section of the six verified PEP volumes, in book order, with
 * the two function placements that are pedagogically suited to the existing tool. A fixture
 * can prove the loader works; only the shipped files can prove the directory is the book.
 *
 * The numbers asserted here come from docs/research/pep-math-six-volumes.md (six local
 * mirror PDFs, table-of-contents page plus body-page double check): 34 chapters, 98 numbered
 * sections and 10 integrated-practice items. If a volume is re-imported, these counts are
 * what changes — deliberately, in one place, with the research document.
 */

const CURRENT = 'pep-math-2022';
const LEGACY = 'pep-math-9b-legacy';
const LINEAR = 'math.functions.pep-8b-ch23-s2-linear-graph';
const QUADRATIC = 'math.functions.pep-9a-ch26-s2-quadratic-graph';

let harness: AuthHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

function shipped() {
  return loadContentIndex(CONTENT_DIR);
}

/** Every section node of every catalog, with the book/chapter it belongs to. */
function sectionNodes(): { catalogId: string; bookId: string; chapterId: string; label: string }[] {
  const index = shipped();
  return index.catalogs.flatMap((catalog) =>
    catalog.books.flatMap((book) =>
      book.chapters.flatMap((chapter) =>
        chapter.sections.map((section) => ({
          catalogId: catalog.catalogId,
          bookId: book.bookId,
          chapterId: chapter.chapterId,
          label: section.labels['zh-CN'],
        })),
      ),
    ),
  );
}

describe('six-volume PEP math directory (shipped content)', () => {
  it('publishes both textbook editions as peer catalogs of the subject, in catalog order', () => {
    const index = shipped();
    const math = index.catalogs.filter((catalog) => catalog.subject === 'math');

    // Real textbooks come first; the two R8 illustrative pilots stay, unchanged, after them.
    expect(math.map((catalog) => catalog.catalogId)).toEqual([
      CURRENT,
      LEGACY,
      'pilot-edition',
      'pilot-edition-b',
    ]);
    expect(math.map((catalog) => catalog.order)).toEqual([1, 2, 3, 4]);

    const current = math[0];
    expect(current?.books.map((book) => book.bookId)).toEqual([
      'pep-math-7a-2024',
      'pep-math-7b-2025',
      'pep-math-8a-2025',
      'pep-math-8b-2026',
      'pep-math-9a-2026',
    ]);

    // The grade-9 volume is its own textbook entry, never a sixth book of the 2022 edition.
    // Nothing groups the two editions apart from `order`: the directory lists them side by side.
    const legacy = math[1];
    expect(legacy?.books.map((book) => book.bookId)).toEqual(['pep-math-9b-legacy']);
    expect(current?.books.some((book) => book.bookId.includes('9b'))).toBe(false);
    expect(Object.keys(current ?? {}).sort()).toEqual(Object.keys(legacy ?? {}).sort());
  });

  it('numbers the current edition 1-30 across its five books, without a gap or a repeat', () => {
    const current = shipped().catalogs.find((catalog) => catalog.catalogId === CURRENT);
    const orders = current?.books.flatMap((book) => book.chapters.map((chapter) => chapter.order));
    expect(orders).toEqual(Array.from({ length: 30 }, (_, position) => position + 1));

    const perBook = current?.books.map((book) => book.chapters.length);
    expect(perBook).toEqual([6, 6, 6, 6, 6]);
    // Chapter order is unique inside its book, which is where the directory reads it.
    for (const book of current?.books ?? []) {
      expect(new Set(book.chapters.map((chapter) => chapter.order)).size).toBe(book.chapters.length);
    }
  });

  it('keeps the 2011 edition at chapters 26-29, with its own topics and its own edition line', () => {
    const math = shipped().catalogs.filter((catalog) => catalog.subject === 'math');
    const current = math[0];
    const legacy = math[1];

    const legacyBook = legacy?.books[0];
    expect(legacyBook?.chapters.map((chapter) => chapter.order)).toEqual([26, 27, 28, 29]);
    expect(legacyBook?.chapters.map((chapter) => chapter.labels['zh-CN'])).toEqual([
      '第二十六章 反比例函数',
      '第二十七章 相似',
      '第二十八章 锐角三角函数',
      '第二十九章 投影与视图',
    ]);

    // Same number, different chapter: the current edition's 26 is 二次函数.
    const currentChapters = current?.books.flatMap((book) => book.chapters) ?? [];
    expect(currentChapters.find((chapter) => chapter.order === 26)?.labels['zh-CN']).toBe(
      '第二十六章 二次函数',
    );

    expect(current?.editionStatus).toBe('current-2022');
    expect(legacy?.editionStatus).toBe('legacy-2011');
    // The edition is named as a fact (2011 curriculum, its own chapter numbering), and the
    // catalog is not labelled as the "old" one of a pair: both editions are peers.
    expect(legacy?.labels['zh-CN']).toMatch(/2011/);
    expect(legacy?.labels['zh-CN']).not.toMatch(/旧版|新版|现行|五册/);
    expect(legacy?.labels['en']).not.toMatch(/legacy|old edition|current five volumes/i);
    expect(legacyBook?.labels['zh-CN']).toBe('九年级下册');
    expect(current?.labels['zh-CN']).not.toMatch(/五册|旧版|新版/);
    expect(legacy?.revision?.['zh-CN']).toMatch(/2011/);
    // Neither volume may claim an edition it cannot show.
    expect(current?.publisher?.['zh-CN']).toBe('人民教育出版社');
    expect(current?.revision?.['en']).toMatch(/2022 curriculum revision/);
  });

  it('carries every vetted chapter and section: 34 chapters, 98 sections, 10 integrated practice', () => {
    const nodes = sectionNodes();
    const index = shipped();
    const chapters = index.catalogs
      .filter((catalog) => catalog.catalogId === CURRENT || catalog.catalogId === LEGACY)
      .flatMap((catalog) => catalog.books.flatMap((book) => book.chapters));
    const numbered = nodes.filter((node) => /^\d+\.\d+ /.test(node.label));
    const projects = nodes.filter((node) => node.label.startsWith('综合与实践 '));

    expect(chapters).toHaveLength(34);
    expect(numbered).toHaveLength(98);
    expect(projects).toHaveLength(10);
    expect(nodes).toHaveLength(108);

    // The two function sections this round places a tool in, with the printed page the
    // research document records (the page a teacher would turn to).
    const current8b = index.catalogs
      .find((catalog) => catalog.catalogId === CURRENT)
      ?.books.find((book) => book.bookId === 'pep-math-8b-2026');
    const ch23 = current8b?.chapters.find((chapter) => chapter.chapterId === 'pep-math-8b-2026-ch23');
    const s23_2 = ch23?.sections.find((section) => section.sectionId === 'pep-math-8b-2026-ch23-s2');
    expect(s23_2?.labels['zh-CN']).toBe('23.2 一次函数的图象和性质');
    expect(s23_2?.printedPage).toBe(117);
    expect(ch23?.printedPage).toBe(113);

    const current9a = index.catalogs
      .find((catalog) => catalog.catalogId === CURRENT)
      ?.books.find((book) => book.bookId === 'pep-math-9a-2026');
    const ch26 = current9a?.chapters.find((chapter) => chapter.chapterId === 'pep-math-9a-2026-ch26');
    const s26_2 = ch26?.sections.find((section) => section.sectionId === 'pep-math-9a-2026-ch26-s2');
    expect(s26_2?.labels['zh-CN']).toBe('26.2 二次函数的图象和性质');
    expect(s26_2?.printedPage).toBe(33);
  });

  it('places the one function tool in 8b 23.2 and 9a 26.2, with distinct presets and stable ids', () => {
    const index = shipped();
    const placed = index.placements.filter((placement) => placement.catalogId === CURRENT);

    expect(placed.map((placement) => placement.placementId)).toEqual([LINEAR, QUADRATIC]);
    expect(placed.map((placement) => placement.slug)).toEqual([
      'pep-8b-23-2-linear-graph',
      'pep-9a-26-2-quadratic-graph',
    ]);
    expect(placed.map((placement) => placement.experimentId)).toEqual([
      'math.functions',
      'math.functions',
    ]);
    // Same tool, one implementation: only the position and the preset differ.
    expect(new Set(placed.map((placement) => placement.experimentId)).size).toBe(1);

    const [linear, quadratic] = placed;
    expect(linear?.chapterId).toBe('pep-math-8b-2026-ch23');
    expect(linear?.sectionId).toBe('pep-math-8b-2026-ch23-s2');
    expect(linear?.section?.labels['zh-CN']).toBe('23.2 一次函数的图象和性质');
    expect(linear?.chapter.labels['zh-CN']).toBe('第二十三章 一次函数');
    expect(linear?.preset).toEqual({ mode: 'linear', a: 2, b: 1, c: 0 });

    expect(quadratic?.chapterId).toBe('pep-math-9a-2026-ch26');
    expect(quadratic?.sectionId).toBe('pep-math-9a-2026-ch26-s2');
    expect(quadratic?.section?.labels['zh-CN']).toBe('26.2 二次函数的图象和性质');
    expect(quadratic?.chapter.labels['zh-CN']).toBe('第二十六章 二次函数');
    expect(quadratic?.preset).toEqual({ mode: 'quadratic', a: 1, b: -4, c: 3 });

    // Distinct presets: identical parameters would make the two chapters indistinguishable.
    expect(linear?.preset).not.toEqual(quadratic?.preset);
    expect(placed.map((placement) => `${String(placement.version)}/${String(placement.order)}`)).toEqual([
      '1/1',
      '1/1',
    ]);
    // Both point into a verified catalog, so neither is labelled a pilot example.
    expect(placed.map((placement) => placement.status)).toEqual(['verified', 'verified']);
  });

  it('leaves the rest of the six volumes without a tool instead of inventing one', () => {
    const index = shipped();
    const placedSections = new Set(
      index.placements
        .map((placement) => placement.sectionId)
        .filter((value): value is string => value !== null),
    );
    const placedChapters = new Set(
      index.placements
        .filter(
          (placement) =>
            placement.sectionId === null &&
            (placement.catalogId === CURRENT || placement.catalogId === LEGACY),
        )
        .map((placement) => `${placement.catalogId}/${placement.chapterId}`),
    );

    // Exactly two sections of the whole directory host a tool this round.
    expect([...placedSections].sort()).toEqual([
      'pep-math-8b-2026-ch23-s2',
      'pep-math-9a-2026-ch26-s2',
    ]);
    expect(placedChapters.size).toBe(0);

    // 23.3 (一次函数与方程、不等式) is deliberately not mapped: the tool models a graph, not
    // the equation/inequality relationship. Same for 22.1 (函数的概念).
    expect([...placedSections]).not.toContain('pep-math-8b-2026-ch23-s3');
    expect([...placedSections]).not.toContain('pep-math-8b-2026-ch22-s1');
  });

  it('keeps the four R8 example entries and their ids untouched next to the new ones', () => {
    const placements = shipped().placements;
    const byId = new Map(placements.map((placement) => [placement.placementId, placement]));

    // Old links, saved snapshots and bookmarks point at these ids and slugs; a scope reset
    // that renamed them would silently break every personal snapshot already stored.
    const oldEntries = [
      ['math.functions.pilot-linear-slope', 'pilot-linear-slope', 'pilot-edition', 'pilot-chapter-a'],
      ['math.functions.pilot-quadratic-vertex', 'pilot-quadratic-vertex', 'pilot-edition', 'pilot-chapter-b'],
      ['math.functions.pilot-vertex-first', 'pilot-vertex-first', 'pilot-edition-b', 'pilot-chapter-b1-vertex'],
      ['math.functions.pilot-slope-after', 'pilot-slope-after', 'pilot-edition-b', 'pilot-chapter-b2-slope'],
    ] as const;
    for (const [placementId, slug, catalogId, chapterId] of oldEntries) {
      const placement = byId.get(placementId);
      expect(placement?.slug).toBe(slug);
      expect(placement?.catalogId).toBe(catalogId);
      expect(placement?.chapterId).toBe(chapterId);
      expect(placement?.status).toBe('illustrative');
      expect(placement?.version).toBe(1);
    }

    // All six entries are the same tool; the new ones only differ in position and preset.
    expect(new Set(placements.map((placement) => placement.experimentId))).toEqual(
      new Set(['math.functions']),
    );
    expect(placements).toHaveLength(6);
  });

  it('serves the six-volume tree over HTTP with sections, pages and each edition line', async () => {
    harness = await startAuthHarness();
    const created = await register(harness.app, { identifier: 'teacher@example.com' });
    expect(created.status).toBe(201);
    const response = await api(harness.app, {
      method: 'GET',
      url: '/api/curriculum?locale=zh-CN',
      headers: cookieHeader(created.cookie()),
    });
    expect(response.status).toBe(200);

    const body = response.body as unknown as {
      items: {
        placementId: string;
        catalogId: string;
        chapterId: string;
        sectionId?: string;
        section?: { id: string; label: string };
        chapter: { label: string };
        edition: { label: string };
        preset: Record<string, number | string>;
      }[];
      catalogs: {
        catalogId: string;
        editionStatus?: string;
        books: {
          bookId: string;
          chapters: {
            chapterId: string;
            label: string;
            printedPage?: number;
            placementIds: string[];
            sections: {
              sectionId: string;
              label: string;
              printedPage?: number;
              placementIds: string[];
            }[];
          }[];
        }[];
      }[];
    };

    expect(body.catalogs.map((catalog) => catalog.catalogId)).toEqual([
      CURRENT,
      LEGACY,
      'pilot-edition',
      'pilot-edition-b',
    ]);
    expect(body.catalogs.map((catalog) => catalog.editionStatus)).toEqual([
      'current-2022',
      'legacy-2011',
      undefined,
      undefined,
    ]);

    const current = body.catalogs[0];
    expect(current?.books).toHaveLength(5);
    const ch23 = current?.books
      .flatMap((book) => book.chapters)
      .find((chapter) => chapter.chapterId === 'pep-math-8b-2026-ch23');
    expect(ch23?.label).toBe('第二十三章 一次函数');
    expect(ch23?.printedPage).toBe(113);
    expect(ch23?.sections.map((section) => section.sectionId)).toEqual([
      'pep-math-8b-2026-ch23-s1',
      'pep-math-8b-2026-ch23-s2',
      'pep-math-8b-2026-ch23-s3',
      'pep-math-8b-2026-ch23-s4',
      'pep-math-8b-2026-ch23-project',
    ]);
    expect(ch23?.sections.map((section) => section.printedPage)).toEqual([114, 117, 127, 131, 143]);
    // The empty sections say so with an empty list, not by disappearing.
    expect(ch23?.sections.map((section) => section.placementIds)).toEqual([
      [],
      [LINEAR],
      [],
      [],
      [],
    ]);

    const linearItem = body.items.find((item) => item.placementId === LINEAR);
    expect(linearItem?.sectionId).toBe('pep-math-8b-2026-ch23-s2');
    expect(linearItem?.section).toEqual({
      id: 'pep-math-8b-2026-ch23-s2',
      label: '23.2 一次函数的图象和性质',
    });
    expect(linearItem?.chapter.label).toBe('第二十三章 一次函数');
    expect(linearItem?.preset).toEqual({ mode: 'linear', a: 2, b: 1, c: 0 });
    const quadraticItem = body.items.find((item) => item.placementId === QUADRATIC);
    expect(quadraticItem?.section?.label).toBe('26.2 二次函数的图象和性质');
    expect(quadraticItem?.preset).toEqual({ mode: 'quadratic', a: 1, b: -4, c: 3 });

    // The grade-9 book is a peer catalog with an edition line of its own.
    expect(body.catalogs[1]?.editionStatus).toBe('legacy-2011');
    expect(body.catalogs[1]?.books[0]?.chapters.map((chapter) => chapter.label)).toEqual([
      '第二十六章 反比例函数',
      '第二十七章 相似',
      '第二十八章 锐角三角函数',
      '第二十九章 投影与视图',
    ]);

    // No file name, path or PDF reference leaks into the response.
    expect(/curricula\/|experiments[\\/]|\.json|\.pdf/i.test(JSON.stringify(body))).toBe(false);
  });
});
