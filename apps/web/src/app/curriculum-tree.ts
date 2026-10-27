import type {
  CurriculumBook,
  CurriculumCatalog,
  CurriculumChapter,
  CurriculumItem,
  CurriculumSection,
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
