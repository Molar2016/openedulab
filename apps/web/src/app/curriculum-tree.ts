import type {
  CurriculumBook,
  CurriculumCatalog,
  CurriculumChapter,
  CurriculumItem,
  CurriculumSection,
  CurriculumStage,
} from '../services/api';

/**
 * Navigation tree for the curriculum directory (ADR-004, extended by ADR-006):
 * `subject → catalog (textbook edition) → book → chapter → section → tool entry`.
 *
 * Pure and defensive on purpose:
 *
 * - Every level is sorted by the explicit `order` the catalog declares. Nothing is inferred
 *   from the tool id, the grade, the array position or the alphabet. Two catalogs may order
 *   the same conceptual chapters differently, and each keeps its own order here.
 * - A placement id that no longer resolves is dropped instead of rendering a placeholder;
 *   an empty chapter or section is kept, because "no tool published here yet" is a real state.
 * - A chapter lists every tool inside it (including the ones that sit in a section), so this
 *   builder assigns each entry to exactly one place: its section when the chapter publishes
 *   that section, otherwise the chapter itself. The page therefore renders each entry once.
 * - A subject is only a navigation grouping. There is no class, term, cohort or progress
 *   record anywhere in this model, and nothing here reads personal data.
 */

export interface CurriculumSectionGroup {
  readonly section: CurriculumSection;
  readonly entries: readonly CurriculumItem[];
}

export interface CurriculumChapterGroup {
  readonly chapter: CurriculumChapter;
  /** Entries that sit on the chapter itself (or in a section this catalog does not publish). */
  readonly entries: readonly CurriculumItem[];
  readonly sections: readonly CurriculumSectionGroup[];
}

export interface CurriculumBookGroup {
  readonly book: CurriculumBook;
  readonly chapters: readonly CurriculumChapterGroup[];
}

export interface CurriculumCatalogGroup {
  readonly catalog: CurriculumCatalog;
  readonly books: readonly CurriculumBookGroup[];
}

export interface CurriculumSubjectGroup {
  readonly subject: string;
  readonly catalogs: readonly CurriculumCatalogGroup[];
}

function byOrderThenId<T extends { order: number }>(left: T, right: T, id: (value: T) => string): number {
  if (left.order !== right.order) return left.order - right.order;
  return id(left).localeCompare(id(right));
}

export function buildCurriculumTree(
  items: readonly CurriculumItem[],
  catalogs: readonly CurriculumCatalog[],
): readonly CurriculumSubjectGroup[] {
  const entriesById = new Map(items.map((item) => [item.placementId, item]));

  const resolve = (placementIds: readonly string[]): CurriculumItem[] =>
    [...placementIds]
      .map((placementId) => entriesById.get(placementId))
      .filter((entry): entry is CurriculumItem => entry !== undefined)
      .sort((left, right) => byOrderThenId(left, right, (entry) => entry.placementId));

  const sortedCatalogs = [...catalogs].sort((left, right) =>
    byOrderThenId(left, right, (catalog) => catalog.catalogId),
  );

  const bySubject = new Map<string, CurriculumCatalogGroup[]>();
  for (const catalog of sortedCatalogs) {
    const books = [...catalog.books]
      .sort((left, right) => byOrderThenId(left, right, (book) => book.bookId))
      .map((book) => ({
        book,
        chapters: [...book.chapters]
          .sort((left, right) => byOrderThenId(left, right, (chapter) => chapter.chapterId))
          .map((chapter) => {
            const inChapter = resolve(chapter.placementIds);
            const sections = [...(chapter.sections ?? [])]
              .sort((left, right) => byOrderThenId(left, right, (section) => section.sectionId))
              .map((section) => ({ section, entries: resolve(section.placementIds) }));
            const publishedSections = new Set(sections.map((group) => group.section.sectionId));
            return {
              chapter,
              // An entry whose section this catalog does not publish stays visible on the
              // chapter instead of disappearing from the directory.
              entries: inChapter.filter(
                (entry) =>
                  entry.sectionId === undefined || !publishedSections.has(entry.sectionId),
              ),
              sections,
            };
          }),
      }));
    const group = bySubject.get(catalog.subject) ?? [];
    group.push({ catalog, books });
    bySubject.set(catalog.subject, group);
  }

  // Subject tags are sorted so the page order does not depend on which file was read first.
  return [...bySubject.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([subject, groups]) => ({ subject, catalogs: groups }));
}


/**
 * The textbook directory a teacher actually navigates (teacher navigation A):
 * `学段 → 课程 → 一册册教材 → 章 → 节 → 工具`.
 *
 * The server's catalog is a content container: one catalog may hold five volumes (the 2022
 * edition) and another a single volume of a different printed edition. That grouping is a
 * publishing fact, not a step a teacher takes — they hold one volume. So every book of every
 * *verified* catalog becomes one card here, and the catalog only contributes metadata
 * (publisher, edition) and the stage it declares.
 *
 * Illustrative catalogs are examples, not textbooks: they stay out of this list. Nothing is
 * deleted — their placements keep their own `/curriculum/<slug>` URLs and personal snapshots.
 */
export interface TextbookBook {
  /** Stable identity of this volume: two catalogs may reuse a book id in theory. */
  readonly key: string;
  readonly bookId: string;
  readonly catalogId: string;
  readonly subject: string;
  readonly stage: CurriculumStage;
  readonly label: string;
  /** Publisher of the printed volume, when the catalog is a verified textbook. */
  readonly publisher?: string;
  /**
   * Which printed edition line this is, when the catalog declares one. The card prints the
   * translated short label for it; the book header keeps the full revision text.
   */
  readonly editionStatus?: 'current-2022' | 'legacy-2011';
  readonly edition: string;
  readonly chapterCount: number;
  /** Chapters with their sections and resolved tool entries, in book order. */
  readonly chapters: readonly CurriculumChapterGroup[];
}

export interface TextbookCourse {
  readonly subject: string;
  readonly books: readonly TextbookBook[];
}

export interface CurriculumStageGroup {
  readonly stage: CurriculumStage;
  readonly courses: readonly TextbookCourse[];
}

const STAGE_ORDER: readonly CurriculumStage[] = ['primary', 'middle', 'high'];

/**
 * A catalog is a textbook list entry only when it is a verified textbook *and* declares the
 * school stage it belongs to. An example is not a textbook; a catalog with no stage cannot be
 * filed under 小学/初中/高中 without inventing data.
 */
function isTextbook(catalog: CurriculumCatalog): boolean {
  return catalog.status === 'verified' && catalog.stage !== undefined;
}

export function buildTextbookDirectory(
  tree: readonly CurriculumSubjectGroup[],
): readonly CurriculumStageGroup[] {
  const stages = new Map<CurriculumStage, Map<string, TextbookBook[]>>();

  for (const subjectGroup of tree) {
    for (const { catalog, books } of subjectGroup.catalogs) {
      if (!isTextbook(catalog) || catalog.stage === undefined) continue;
      const courses = stages.get(catalog.stage) ?? new Map<string, TextbookBook[]>();
      const list = courses.get(subjectGroup.subject) ?? [];
      for (const { book, chapters } of books) {
        list.push({
          key: `${catalog.catalogId}/${book.bookId}`,
          bookId: book.bookId,
          catalogId: catalog.catalogId,
          subject: subjectGroup.subject,
          stage: catalog.stage,
          label: book.label,
          ...(catalog.publisher === undefined ? {} : { publisher: catalog.publisher }),
          edition: catalog.revision ?? catalog.label,
          ...(catalog.editionStatus === undefined
            ? {}
            : { editionStatus: catalog.editionStatus }),
          chapterCount: book.chapters.length,
          chapters,
        });
      }
      courses.set(subjectGroup.subject, list);
      stages.set(catalog.stage, courses);
    }
  }

  return STAGE_ORDER.filter((stage) => stages.has(stage)).map((stage) => ({
    stage,
    courses: [...(stages.get(stage) ?? new Map<string, TextbookBook[]>()).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subject, books]) => ({ subject, books })),
  }));
}

/**
 * Abbreviations teachers type for a publisher whose full name is on the card. The wire sends
 * the publisher in the active language, so each entry lists the names it can arrive as — a
 * shared zh link and its en rendering both have to answer to "人教" / "PEP".
 */
const PUBLISHER_ALIASES: readonly {
  readonly names: readonly string[];
  readonly aliases: readonly string[];
}[] = [
  {
    names: ['人民教育出版社', "people's education press"],
    aliases: ['人教', '人教版', 'pep'],
  },
  { names: ['北京师范大学出版社', 'beijing normal university press'], aliases: ['北师大', 'bnu'] },
  { names: ['江苏凤凰教育出版社', 'jiangsu phoenix education press'], aliases: ['苏教', '苏教版'] },
];

const CHINESE_DIGITS: Readonly<Record<string, string>> = {
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  '7': '七',
  '8': '八',
  '9': '九',
};

/**
 * Volume shorthands a teacher types: "八下" for 八年级下册, "8下" for the English label of the
 * same book. The label alone is not enough — at `en` the server sends "Grade 8, volume 2" — so
 * the book id (`pep-math-8b-2026`) is read for grade + semester as well.
 */
function volumeShorthands(book: TextbookBook): string[] {
  const shorthands = new Set<string>();
  const label = book.label.replace(/\s+/g, '');
  const fromLabel = label.replace('年级', '').replace('上册', '上').replace('下册', '下');
  if (fromLabel !== label) shorthands.add(fromLabel);

  const match = /(?:^|-)(\d)([ab])(?:-|$)/.exec(book.bookId);
  if (match !== null) {
    const grade = match[1] as string;
    const semester = match[2] === 'a' ? '上' : '下';
    shorthands.add(`${grade}${semester}`);
    const chinese = CHINESE_DIGITS[grade];
    if (chinese !== undefined) shorthands.add(`${chinese}${semester}`);
  }
  return [...shorthands];
}

export interface TextbookSearchTerms {
  readonly query: string;
  /** Localized course label, e.g. 数学 / Mathematics. */
  readonly subject: string;
  /** Localized stage label, e.g. 初中 / Middle school. */
  readonly stage: string;
}

/**
 * Whether a teacher's search words describe this volume. Every word has to match somewhere on
 * the card or in its metadata — publisher (with its common abbreviation), subject, stage,
 * grade, semester and edition — so "人教 八下" finds exactly 八年级下册 and "2022" finds the
 * volumes of that revision.
 */
export function matchesTextbook(book: TextbookBook, terms: TextbookSearchTerms): boolean {
  const tokens = terms.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const publisher = book.publisher ?? '';
  const lowerPublisher = publisher.toLowerCase();
  const aliases = PUBLISHER_ALIASES.filter((entry) =>
    entry.names.some((name) => lowerPublisher.includes(name)),
  ).flatMap((entry) => entry.aliases);

  const haystack = [
    book.label,
    book.edition,
    publisher,
    ...aliases,
    book.subject,
    book.stage,
    terms.subject,
    terms.stage,
    ...volumeShorthands(book),
  ]
    .join(' ')
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}
