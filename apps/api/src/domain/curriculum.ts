import { validateStateValues, type StateSchema, type StateValue } from './state-validator.js';

/**
 * Declared locally on purpose: `content-index.ts` imports this module, so importing its
 * locale list back would create a cycle for no benefit.
 */
export const PLACEMENT_LOCALES = ['zh-CN', 'en'] as const;
export type PlacementLocale = (typeof PLACEMENT_LOCALES)[number];

/**
 * Curriculum catalogs and placements (ADR-003, extended by ADR-004 and ADR-005).
 *
 * The tree is `subject → catalog (textbook edition) → book → chapter → tool entry`:
 *
 * - A **catalog** is one textbook version with a stable id, version, subject and its own
 *   book/chapter tree. Its `order` numbers are the only source of directory order; the tool
 *   id, the grade or the file order never decide anything.
 * - Catalogs are **subject-level content**, not a tool's private appendix: they live in
 *   `curricula/<subject>/<file>.json` (ADR-005), so the tree exists whether or not any tool
 *   is placed in it, and one chapter can host several tools.
 * - A **placement** is a directory entry inside one tool's `curriculum.json`: it names the
 *   stable tool id it reuses, its own stable id + version, the exact chapter it sits in
 *   (`catalogId`/`bookId`/`chapterId`) and one preset parameter set. A tool file carries
 *   placements only — never a catalog.
 * - `illustrative` means "example, not a verified textbook". Such a catalog **may not**
 *   declare a publisher or edition, because that would be a fabricated citation; a
 *   `verified` catalog must declare both. Nothing in this module can verify chapter names —
 *   that is a content review, so a verified catalog is a claim a human made in the file.
 *
 * Everything is validated at startup together with the manifests: a preset the tool's own
 * `state-schema.json` would reject, a chapter that does not exist, a duplicated book order,
 * a catalog order claimed twice in one subject or a catalog that claims a publisher while
 * marked illustrative all refuse to start rather than render a page that lies about the
 * curriculum.
 *
 * This module never touches the filesystem or the database: it turns one parsed JSON value
 * into validated data, so both the index and the tests use the same rules.
 */

export const PLACEMENT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
export const PLACEMENT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Catalog subjects are the same tags experiment manifests use (`math`, `physics`, ...). */
export const SUBJECT_TAG = /^[a-z0-9][a-z0-9-]*$/;
/** `curriculum.json` is placements only (ADR-005). */
export const CURRICULUM_SCHEMA_VERSION = 3;
/** One `curricula/<subject>/<file>.json` document. */
export const CATALOG_SCHEMA_VERSION = 1;
/**
 * Which printed edition line a catalog belongs to (ADR-006). A tag rather than free text: the
 * interface has to say "this is the old book still in use" in a sentence a teacher reads, and
 * that sentence is translated UI text, not a string each catalog file invents. Catalogs that
 * are examples (`illustrative`) declare none.
 */
export const CATALOG_EDITION_STATUS = ['current-2022', 'legacy-2011'] as const;
export type CatalogEditionStatus = (typeof CATALOG_EDITION_STATUS)[number];
/**
 * The school stage a textbook belongs to (teacher navigation A). It is catalog metadata, not
 * a UI guess: the directory groups volumes by this declared value instead of inferring
 * "middle school" from a grade word in a book title or from the catalog id. Optional, because
 * an illustrative sample is not a volume of any school stage.
 */
export const CATALOG_STAGE = ['primary', 'middle', 'high'] as const;
export type CatalogStage = (typeof CATALOG_STAGE)[number];


export type PlacementStatus = 'illustrative' | 'verified';

export interface PlacementNode {
  readonly id: string;
  readonly labels: Readonly<Record<PlacementLocale, string>>;
}

/**
 * One section (节) of a chapter: printed order inside the chapter, its short title, and the
 * page printed in the book. Sections exist whether or not a tool sits in them — a section with
 * no tool is a real state of the directory, not a row to hide (ADR-006).
 */
export interface CurriculumSection {
  readonly sectionId: string;
  /** Order inside its chapter: 1..n, unique. */
  readonly order: number;
  readonly labels: Readonly<Record<PlacementLocale, string>>;
  /** The page number printed in the book, when the volume numbers its sections. */
  readonly printedPage: number | null;
}

export interface CurriculumChapter {
  readonly chapterId: string;
  /** Order inside its book: 1..n, unique. */
  readonly order: number;
  readonly labels: Readonly<Record<PlacementLocale, string>>;
  /** The page number printed in the book for the chapter opening, when it has one. */
  readonly printedPage: number | null;
  /** Printed sections, in book order; empty for a catalog that only models chapters. */
  readonly sections: readonly CurriculumSection[];
}

export interface CurriculumBook {
  readonly bookId: string;
  /** Order inside its catalog: 1..n, unique. */
  readonly order: number;
  readonly labels: Readonly<Record<PlacementLocale, string>>;
  readonly chapters: readonly CurriculumChapter[];
}

export interface CurriculumCatalog {
  readonly catalogId: string;
  /** Subject tag, e.g. `math`; must be one of the tool's manifest subjects. */
  readonly subject: string;
  readonly version: number;
  readonly status: PlacementStatus;
  /** Order of the catalog inside the directory: 1..n, unique per file. */
  readonly order: number;
  readonly labels: Readonly<Record<PlacementLocale, string>>;
  /** Publisher of a verified textbook; `null` for illustrative catalogs. */
  readonly publisher: Readonly<Record<PlacementLocale, string>> | null;
  /** Edition / printing of a verified textbook; `null` for illustrative catalogs. */
  readonly revision: Readonly<Record<PlacementLocale, string>> | null;
  /**
   * Which printed edition line this is (`current-2022`, `legacy-2011`), or `null` when the
   * catalog is an example rather than a book. The interface turns it into a sentence; the
   * directory order is unaffected by it.
   */
  readonly editionStatus: CatalogEditionStatus | null;
  /**
   * The school stage this textbook is used in (`primary`, `middle`, `high`), or `null` when
   * the catalog does not declare one (an example, or content that has not been classified).
   */
  readonly stage: CatalogStage | null;
  readonly books: readonly CurriculumBook[];
}

export interface CurriculumPlacement {
  readonly placementId: string;
  readonly slug: string;
  /** The stable tool id this placement reuses. */
  readonly experimentId: string;
  readonly version: number;
  /** `illustrative` means "pilot example, not a verified textbook chapter". */
  readonly status: PlacementStatus;
  /** The catalog this entry belongs to, copied so the route never has to guess. */
  readonly catalogId: string;
  readonly bookId: string;
  readonly chapterId: string;
  /**
   * The printed section inside the chapter, or `null` when the entry belongs to the chapter
   * itself. A section is part of the entry's identity: two sections of one chapter are two
   * different places, each with its own preset and its own personal snapshot.
   */
  readonly sectionId: string | null;
  readonly subject: string;
  /** Order inside its chapter (the tool order), 1..n, unique per chapter. */
  readonly order: number;
  readonly catalog: PlacementNode;
  readonly book: PlacementNode;
  readonly chapter: PlacementNode;
  /** The section node, or `null` for a chapter-level entry. */
  readonly section: PlacementNode | null;
  readonly title: Readonly<Record<PlacementLocale, string>>;
  readonly summary: Readonly<Record<PlacementLocale, string>>;
  /** Canonical, schema-validated preset values (sorted keys). */
  readonly preset: Readonly<Record<string, StateValue>>;
  readonly stateSchemaVersion: number;
}

export interface PlacementParseResult {
  readonly placements: readonly CurriculumPlacement[];
  readonly issues: readonly string[];
}

interface SharedUniqueness {
  readonly placementIds: Map<string, string>;
  readonly slugs: Map<string, string>;
  /**
   * `catalogId/bookId/chapterId/order` → placement id. Shared across every tool so two
   * tools cannot claim the same position in one chapter (ADR-005: the chapter is shared,
   * the position inside it is not).
   */
  readonly chapterPositions: Map<string, string>;
}

/** Used by the content index so uniqueness spans every experiment folder. */
export function createPlacementUniqueness(): SharedUniqueness {
  return { placementIds: new Map(), slugs: new Map(), chapterPositions: new Map() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function readLocalized(
  raw: unknown,
  label: string,
  issues: string[],
): Record<PlacementLocale, string> | null {
  if (!isPlainObject(raw)) {
    issues.push(`${label} must be an object with "zh-CN" and "en" texts`);
    return null;
  }
  const texts = {} as Record<PlacementLocale, string>;
  let ok = true;
  for (const locale of PLACEMENT_LOCALES) {
    const value = raw[locale];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(`${label}.${locale} must be a non-empty string`);
      ok = false;
      continue;
    }
    texts[locale] = value;
  }
  const extra = Object.keys(raw).filter(
    (key) => !(PLACEMENT_LOCALES as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    issues.push(`${label} has unknown locales: ${extra.join(', ')}`);
    ok = false;
  }
  return ok ? texts : null;
}

type OrderedNodeKind = 'book' | 'chapter' | 'section';

const ORDERED_NODE_KEYS: Readonly<Record<OrderedNodeKind, readonly string[]>> = {
  book: ['bookId', 'order', 'label', 'chapters'],
  chapter: ['chapterId', 'order', 'label', 'printedPage', 'sections'],
  section: ['sectionId', 'order', 'label', 'printedPage'],
};

const ORDERED_NODE_IDS: Readonly<Record<OrderedNodeKind, string>> = {
  book: 'bookId',
  chapter: 'chapterId',
  section: 'sectionId',
};

/**
 * A catalog node (book, chapter or section): kebab-case id, explicit positive order, localized
 * label, and for chapters/sections the page printed in the book. The kind decides which keys
 * are legal, so a chapter cannot smuggle in a section list of the wrong shape.
 */
function readOrderedNode(
  raw: unknown,
  where: string,
  kind: OrderedNodeKind,
  issues: string[],
): {
  id: string;
  order: number;
  labels: Record<PlacementLocale, string>;
  printedPage: number | null;
} | null {
  const idKey = ORDERED_NODE_IDS[kind];
  if (!isPlainObject(raw)) {
    issues.push(`${where} must be an object with "${idKey}", "order" and "label"`);
    return null;
  }
  const allowed = new Set(ORDERED_NODE_KEYS[kind]);
  const unexpected = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    issues.push(`${where} has unexpected keys: ${unexpected.join(', ')}`);
  }
  const id = raw[idKey];
  const order = raw.order;
  if (typeof id !== 'string' || !PLACEMENT_SLUG.test(id)) {
    issues.push(`${where}.${idKey} must be kebab-case`);
  }
  if (!isPositiveInteger(order)) {
    issues.push(`${where} ${kind} order must be an integer >= 1`);
  }
  let printedPage: number | null = null;
  if (raw.printedPage !== undefined) {
    if (!isPositiveInteger(raw.printedPage)) {
      issues.push(`${where}.printedPage must be a positive integer (the page printed in the book)`);
    } else {
      printedPage = raw.printedPage;
    }
  }
  const labels = readLocalized(raw.label, `${where}.label`, issues);
  if (typeof id !== 'string' || labels === null || !isPositiveInteger(order)) return null;
  return { id, order, labels, printedPage };
}

/**
 * Reads the `sections[]` of one chapter (ADR-006). Absent means "this catalog models chapters
 * only", which is what the R8 illustrative catalogs do; present means every entry must be a
 * usable section, because a half-read section list would silently drop part of the book.
 */
function readSections(
  rawChapter: Record<string, unknown>,
  where: string,
  chapterId: string,
  issues: string[],
): CurriculumSection[] | null {
  const raw = rawChapter.sections;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(`${where}.sections must be an array`);
    return null;
  }
  const sections: CurriculumSection[] = [];
  const seenIds = new Map<string, string>();
  const seenOrders = new Map<number, string>();
  let ok = true;
  raw.forEach((candidate, index) => {
    const sectionWhere = `${where}.sections[${String(index)}]`;
    const section = readOrderedNode(candidate, sectionWhere, 'section', issues);
    if (section === null) {
      ok = false;
      return;
    }
    const idOwner = seenIds.get(section.id);
    if (idOwner !== undefined) {
      issues.push(
        `duplicate sectionId "${section.id}" in chapter "${chapterId}" (two sections would share one entry point)`,
      );
      ok = false;
    }
    const orderOwner = seenOrders.get(section.order);
    if (orderOwner !== undefined) {
      issues.push(
        `section order ${String(section.order)} is already used by "${orderOwner}" in chapter "${chapterId}"`,
      );
      ok = false;
    }
    seenIds.set(section.id, section.id);
    seenOrders.set(section.order, section.id);
    sections.push({
      sectionId: section.id,
      order: section.order,
      labels: section.labels,
      printedPage: section.printedPage,
    });
  });
  sections.sort((left, right) => left.order - right.order);
  return ok ? sections : null;
}

function readBooks(
  rawCatalog: Record<string, unknown>,
  where: string,
  catalogId: string,
  issues: string[],
): CurriculumBook[] | null {
  if (!Array.isArray(rawCatalog.books)) {
    issues.push(`${where}.books must be an array`);
    return null;
  }
  if (rawCatalog.books.length === 0) {
    issues.push(
      `${where}.books must not be empty (a catalog without a book has nowhere to place a tool)`,
    );
    return null;
  }
  const books: CurriculumBook[] = [];
  const seenBookIds = new Map<string, string>();
  const seenBookOrders = new Map<number, string>();
  const seenChapterIds = new Map<string, string>();

  rawCatalog.books.forEach((rawBook, bookIndex) => {
    const bookWhere = `${where}.books[${String(bookIndex)}]`;
    const book = readOrderedNode(rawBook, bookWhere, 'book', issues);
    if (book === null) return;
    let ok = true;

    const bookOwner = seenBookIds.get(book.id);
    if (bookOwner !== undefined) {
      issues.push(`duplicate bookId "${book.id}" in catalog "${catalogId}"`);
      ok = false;
    }
    const orderOwner = seenBookOrders.get(book.order);
    if (orderOwner !== undefined) {
      issues.push(
        `book order ${String(book.order)} is already used by "${orderOwner}" in catalog "${catalogId}"`,
      );
      ok = false;
    }

    const rawChapters = (rawBook as Record<string, unknown>).chapters;
    if (!Array.isArray(rawChapters)) {
      issues.push(`${bookWhere}.chapters must be an array`);
      return;
    }
    if (rawChapters.length === 0) {
      issues.push(`${bookWhere}.chapters must not be empty`);
      return;
    }

    const chapters: CurriculumChapter[] = [];
    const seenChapterOrders = new Map<number, string>();
    rawChapters.forEach((rawChapter, chapterIndex) => {
      const chapterWhere = `${bookWhere}.chapters[${String(chapterIndex)}]`;
      const chapter = readOrderedNode(rawChapter, chapterWhere, 'chapter', issues);
      if (chapter === null) return;
      const chapterOwner = seenChapterIds.get(chapter.id);
      if (chapterOwner !== undefined) {
        // Two books may not share a chapter id: a placement names one chapter, and a shared
        // id would make "which book did the teacher mean" unanswerable.
        issues.push(
          `duplicate chapterId "${chapter.id}" in catalog "${catalogId}" (also used by book "${chapterOwner}")`,
        );
        ok = false;
      }
      const chapterOrderOwner = seenChapterOrders.get(chapter.order);
      if (chapterOrderOwner !== undefined) {
        issues.push(
          `chapter order ${String(chapter.order)} is already used by "${chapterOrderOwner}" in book "${book.id}"`,
        );
        ok = false;
      }
      const sections = readSections(
        rawChapter as Record<string, unknown>,
        chapterWhere,
        chapter.id,
        issues,
      );
      if (sections === null) {
        ok = false;
        return;
      }
      seenChapterIds.set(chapter.id, book.id);
      seenChapterOrders.set(chapter.order, chapter.id);
      chapters.push({
        chapterId: chapter.id,
        order: chapter.order,
        labels: chapter.labels,
        printedPage: chapter.printedPage,
        sections,
      });
    });

    seenBookIds.set(book.id, book.id);
    seenBookOrders.set(book.order, book.id);
    if (!ok) return;
    chapters.sort((left, right) => left.order - right.order);
    books.push({ bookId: book.id, order: book.order, labels: book.labels, chapters });
  });

  books.sort((left, right) => left.order - right.order);
  return books;
}

/**
 * Reads the catalogs of one `curricula/<subject>/<file>.json` document.
 *
 * The file's subject is authoritative: every catalog inside must repeat it, so a file can
 * never smuggle a physics catalog into `curricula/math/`. Cross-file uniqueness (a catalog
 * id or a catalog order claimed twice, per subject) is the caller's job — the index and the
 * offline validator both run that pass over every file they loaded.
 */
function readCatalogEntries(
  raw: unknown,
  where: string,
  subject: string,
  issues: string[],
): CurriculumCatalog[] {
  if (!Array.isArray(raw)) {
    issues.push(`${where}.catalogs must be an array`);
    return [];
  }
  if (raw.length === 0) {
    issues.push(
      `${where}.catalogs must not be empty (a catalog file without a catalog has nothing to navigate)`,
    );
    return [];
  }
  const catalogs: CurriculumCatalog[] = [];

  raw.forEach((candidate, index) => {
    const entryWhere = `${where}.catalogs[${String(index)}]`;
    if (!isPlainObject(candidate)) {
      issues.push(`${entryWhere} must be an object`);
      return;
    }
    const entryIssues: string[] = [];
    const catalogId = typeof candidate.catalogId === 'string' ? candidate.catalogId : '';
    const unexpected = Object.keys(candidate).filter(
      (key) =>
        ![
          'catalogId',
          'subject',
          'version',
          'status',
          'order',
          'label',
          'publisher',
          'revision',
          'editionStatus',
          'stage',
          'books',
        ].includes(key),
    );
    if (unexpected.length > 0) {
      entryIssues.push(`has unexpected keys: ${unexpected.join(', ')}`);
    }
    if (!PLACEMENT_SLUG.test(catalogId)) {
      entryIssues.push(`catalogId "${catalogId}" must be kebab-case`);
    }
    const catalogSubject = typeof candidate.subject === 'string' ? candidate.subject : '';
    if (!SUBJECT_TAG.test(catalogSubject)) {
      entryIssues.push(`subject "${catalogSubject}" must be a tag like "math"`);
    } else if (catalogSubject !== subject) {
      // One subject per file: the directory decides, and the catalog repeats it so a reader
      // can tell which tree an entry belongs to without looking at the path.
      entryIssues.push(`subject "${catalogSubject}" must match this file's subject "${subject}"`);
    }
    if (!isPositiveInteger(candidate.version)) {
      entryIssues.push('version must be an integer >= 1');
    }
    if (candidate.status !== 'illustrative' && candidate.status !== 'verified') {
      entryIssues.push('status must be "illustrative" or "verified"');
    }
    if (!isPositiveInteger(candidate.order)) {
      entryIssues.push('catalog order must be an integer >= 1');
    }
    const labels = readLocalized(candidate.label, `${entryWhere}.label`, entryIssues);
    const publisher =
      candidate.publisher === undefined
        ? null
        : readLocalized(candidate.publisher, `${entryWhere}.publisher`, entryIssues);
    const revision =
      candidate.revision === undefined
        ? null
        : readLocalized(candidate.revision, `${entryWhere}.revision`, entryIssues);
    if (candidate.status === 'verified') {
      if (publisher === null) {
        entryIssues.push('a verified catalog must name its publisher');
      }
      if (revision === null) {
        entryIssues.push('a verified catalog must name its revision/edition');
      }
    } else if (candidate.status === 'illustrative' && (publisher !== null || revision !== null)) {
      entryIssues.push(
        'an illustrative catalog must not declare publisher or revision: that would present made-up bibliographic data as a real textbook',
      );
    }

    // The edition line (ADR-006) is metadata: it records which printed edition a catalog is.
    // Every catalog is a peer entry in the subject directory, so nothing here decides that one
    // edition is shown in a separate zone. An example may not claim an edition, for the same
    // reason it may not claim a publisher.
    let editionStatus: CatalogEditionStatus | null = null;
    if (candidate.editionStatus !== undefined) {
      if (
        typeof candidate.editionStatus !== 'string' ||
        !(CATALOG_EDITION_STATUS as readonly string[]).includes(candidate.editionStatus)
      ) {
        entryIssues.push(
          `editionStatus ${JSON.stringify(candidate.editionStatus)} must be one of ${CATALOG_EDITION_STATUS.map((value) => `"${value}"`).join(', ')}`,
        );
      } else {
        editionStatus = candidate.editionStatus as CatalogEditionStatus;
      }
      if (candidate.status === 'illustrative') {
        entryIssues.push(
          'an illustrative catalog must not declare an edition status: a sample is not a printed edition',
        );
      }
    }

    // The school stage is metadata like the edition line: it tells the directory which
    // 小学/初中/高中 shelf the volume belongs on. Absent is legitimate (an example catalog,
    // or content nobody has classified yet) — it is never derived from the catalog id.
    let stage: CatalogStage | null = null;
    if (candidate.stage !== undefined) {
      if (
        typeof candidate.stage !== 'string' ||
        !(CATALOG_STAGE as readonly string[]).includes(candidate.stage)
      ) {
        entryIssues.push(
          `stage ${JSON.stringify(candidate.stage)} must be one of ${CATALOG_STAGE.map((value) => `"${value}"`).join(', ')}`,
        );
      } else {
        stage = candidate.stage as CatalogStage;
      }
    }

    const books = readBooks(candidate, entryWhere, catalogId, entryIssues);

    if (entryIssues.length > 0) {
      for (const issue of entryIssues) issues.push(`${entryWhere}: ${issue}`);
      return;
    }

    catalogs.push({
      catalogId,
      subject,
      version: candidate.version as number,
      status: candidate.status as PlacementStatus,
      order: candidate.order as number,
      labels: labels as Record<PlacementLocale, string>,
      publisher,
      revision,
      editionStatus,
      stage,
      books: books as CurriculumBook[],
    });
  });

  return catalogs;
}

export interface CatalogFileParseOptions {
  /** Human-readable source, e.g. `curricula/math/pilot.json`, used in messages. */
  readonly source: string;
  /** Directory name; the file may only declare catalogs of this subject. */
  readonly subject: string;
}

export interface CatalogParseResult {
  readonly catalogs: readonly CurriculumCatalog[];
  readonly issues: readonly string[];
}

/**
 * Parses one shared catalog document (ADR-005). Cross-file checks are deliberately absent:
 * a duplicated catalog id or catalog order is a property of the whole subject directory,
 * not of one file, so the content index and the offline validator apply it after loading
 * every file.
 */
export function parseCatalogFile(
  raw: unknown,
  options: CatalogFileParseOptions,
): CatalogParseResult {
  const { source, subject } = options;
  const issues: string[] = [];
  const prefix = `[${source}]`;

  if (!SUBJECT_TAG.test(subject)) {
    return {
      catalogs: [],
      issues: [`${prefix} subject directory "${subject}" must be a tag like "math"`],
    };
  }
  if (!isPlainObject(raw)) {
    return { catalogs: [], issues: [`${prefix} must be a JSON object`] };
  }
  const unexpected = Object.keys(raw).filter(
    (key) => !['schemaVersion', 'subject', 'catalogs', 'note'].includes(key),
  );
  if (unexpected.length > 0) {
    issues.push(`${prefix} has unknown top-level keys: ${unexpected.join(', ')}`);
  }
  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    issues.push(
      `${prefix} schemaVersion must be ${String(CATALOG_SCHEMA_VERSION)} (got ${JSON.stringify(raw.schemaVersion)})`,
    );
  }
  if (raw.subject !== subject) {
    issues.push(
      `${prefix} declares subject ${JSON.stringify(raw.subject)} but lives in the "${subject}" directory: a catalog file may only describe its own subject`,
    );
  }
  if (raw.note !== undefined && typeof raw.note !== 'string') {
    issues.push(`${prefix} note must be a string`);
  }

  const catalogs = readCatalogEntries(raw.catalogs, prefix, subject, issues);
  return { catalogs, issues };
}

export interface PlacementParseOptions {
  readonly experimentId: string;
  /** Manifest subjects; a catalog may only place the tool inside one of them. */
  readonly subjects: readonly string[];
  readonly stateSchema: StateSchema | null;
  /** Folders are reported in messages so a contributor can find the file. */
  readonly folder: string;
  /** Shared across folders: two chapters must not claim the same URL. */
  readonly uniqueness: SharedUniqueness;
  /**
   * Every catalog loaded from `curricula/<subject>/` (ADR-005), keyed by catalog id.
   * A placement points into this map; it may not declare a catalog of its own.
   */
  readonly catalogs: ReadonlyMap<string, CurriculumCatalog>;
}

function findChapter(
  catalog: CurriculumCatalog,
  bookId: string,
  chapterId: string,
): { book: CurriculumBook; chapter: CurriculumChapter } | { problem: string } {
  const book = catalog.books.find((entry) => entry.bookId === bookId);
  if (book === undefined) {
    return { problem: `unknown book "${bookId}" in catalog "${catalog.catalogId}"` };
  }
  const chapter = book.chapters.find((entry) => entry.chapterId === chapterId);
  if (chapter !== undefined) return { book, chapter };
  const otherBook = catalog.books.find((entry) =>
    entry.chapters.some((candidate) => candidate.chapterId === chapterId),
  );
  if (otherBook !== undefined) {
    // Never fall back to a same-named chapter elsewhere: that is how a teacher ends up in
    // the wrong book with a plausible-looking page.
    return {
      problem: `chapter "${chapterId}" belongs to book "${otherBook.bookId}", not "${bookId}"`,
    };
  }
  return { problem: `unknown chapter "${chapterId}" in catalog "${catalog.catalogId}"` };
}

/**
 * Parses one experiment's `curriculum.json` (ADR-005): placements only. A missing file is
 * legitimate (a tool may simply not be in the curriculum yet); anything present but wrong is
 * reported, including a catalog that still tries to live here.
 */
export function parseCurriculum(
  raw: unknown,
  options: PlacementParseOptions,
): PlacementParseResult {
  const { experimentId, subjects, stateSchema, folder, uniqueness, catalogs } = options;
  const issues: string[] = [];
  const placements: CurriculumPlacement[] = [];
  const prefix = `[${folder}] curriculum.json`;

  if (!isPlainObject(raw)) {
    return { placements, issues: [`${prefix} must be a JSON object`] };
  }
  const unexpected = Object.keys(raw).filter(
    (key) => !['schemaVersion', 'placements', 'note'].includes(key),
  );
  if (unexpected.length > 0) {
    issues.push(`${prefix} has unknown top-level keys: ${unexpected.join(', ')}`);
  }
  if (raw.catalogs !== undefined) {
    // Not "unknown key": this is the retired R8 layout, and a contributor needs to be told
    // where the tree went instead of guessing at a schema error.
    issues.push(
      `${prefix} may not declare catalogs: the textbook tree lives in curricula/<subject>/<file>.json (ADR-005) and this file carries placements that reference it`,
    );
  }
  if (raw.schemaVersion !== CURRICULUM_SCHEMA_VERSION) {
    issues.push(
      `${prefix} schemaVersion must be ${String(CURRICULUM_SCHEMA_VERSION)} (got ${JSON.stringify(raw.schemaVersion)})`,
    );
  }

  if (!Array.isArray(raw.placements)) {
    issues.push(`${prefix} placements must be an array`);
    return { placements, issues };
  }

  raw.placements.forEach((candidate, index) => {
    const where = `${prefix} placements[${String(index)}]`;
    if (!isPlainObject(candidate)) {
      issues.push(`${where} must be an object`);
      return;
    }
    const entryIssues: string[] = [];
    const unexpectedKeys = Object.keys(candidate).filter(
      (key) =>
        ![
          'placementId',
          'slug',
          'version',
          'status',
          'catalogId',
          'bookId',
          'chapterId',
          'sectionId',
          'order',
          'title',
          'summary',
          'preset',
        ].includes(key),
    );
    if (unexpectedKeys.length > 0) {
      entryIssues.push(`has unexpected keys: ${unexpectedKeys.join(', ')}`);
    }

    const placementId = typeof candidate.placementId === 'string' ? candidate.placementId : '';
    const slug = typeof candidate.slug === 'string' ? candidate.slug : '';
    if (!PLACEMENT_ID.test(placementId)) {
      entryIssues.push(`placementId "${placementId}" must look like "${experimentId}.<chapter>"`);
    } else if (!placementId.startsWith(`${experimentId}.`)) {
      // A placement is scoped to the tool it lives next to: pointing at another experiment
      // from this folder would make the preset validation meaningless.
      entryIssues.push(`placementId "${placementId}" must start with "${experimentId}."`);
    }
    if (!PLACEMENT_SLUG.test(slug)) {
      entryIssues.push(`slug "${slug}" must be kebab-case`);
    }
    if (!isPositiveInteger(candidate.version)) {
      entryIssues.push('version must be an integer >= 1');
    }
    if (candidate.status !== 'illustrative' && candidate.status !== 'verified') {
      entryIssues.push('status must be "illustrative" or "verified"');
    }
    if (!isPositiveInteger(candidate.order)) {
      entryIssues.push('tool order must be an integer >= 1');
    }
    const catalogId = typeof candidate.catalogId === 'string' ? candidate.catalogId : '';
    const bookId = typeof candidate.bookId === 'string' ? candidate.bookId : '';
    const chapterId = typeof candidate.chapterId === 'string' ? candidate.chapterId : '';
    for (const [key, value] of [
      ['catalogId', catalogId],
      ['bookId', bookId],
      ['chapterId', chapterId],
    ] as const) {
      if (!PLACEMENT_SLUG.test(value)) {
        entryIssues.push(`${key} "${value}" must be kebab-case`);
      }
    }
    // A section is optional: a tool may sit on the chapter itself (the R8 layout) or in one
    // printed section of it (ADR-006). `null` means "the chapter", never "unknown section".
    const sectionId =
      candidate.sectionId === undefined
        ? null
        : typeof candidate.sectionId === 'string'
          ? candidate.sectionId
          : '';
    if (sectionId !== null && !PLACEMENT_SLUG.test(sectionId)) {
      entryIssues.push(`sectionId "${sectionId}" must be kebab-case`);
    }

    const title = readLocalized(candidate.title, `${where}.title`, entryIssues);
    const summary = readLocalized(candidate.summary, `${where}.summary`, entryIssues);

    let preset: Record<string, StateValue> | null = null;
    if (stateSchema === null) {
      entryIssues.push(
        'declares a preset but this experiment has no state-schema.json, so the preset could never be validated',
      );
    } else {
      const validated = validateStateValues(stateSchema, candidate.preset);
      if (!validated.ok) {
        entryIssues.push(
          `preset is not valid for this experiment's state schema (${validated.reason}${
            validated.fields.length > 0 ? `: ${validated.fields.join(', ')}` : ''
          })`,
        );
      } else {
        preset = validated.values;
      }
    }

    let catalog: CurriculumCatalog | undefined;
    let book: CurriculumBook | undefined;
    let chapter: CurriculumChapter | undefined;
    let section: CurriculumSection | null = null;
    if (PLACEMENT_SLUG.test(catalogId)) {
      catalog = catalogs.get(catalogId);
      if (catalog === undefined) {
        entryIssues.push(
          `unknown catalog "${catalogId}": no curricula/<subject>/*.json declares it (a placement may only reference a shared catalog, never declare one)`,
        );
      } else if (!subjects.includes(catalog.subject)) {
        entryIssues.push(
          `catalog "${catalogId}" belongs to subject "${catalog.subject}", which is not one of this tool's manifest subjects (${subjects.join(', ')}) — a tool may not be placed in another subject's textbook`,
        );
      } else if (PLACEMENT_SLUG.test(bookId) && PLACEMENT_SLUG.test(chapterId)) {
        const resolved = findChapter(catalog, bookId, chapterId);
        if ('problem' in resolved) {
          entryIssues.push(resolved.problem);
        } else {
          book = resolved.book;
          chapter = resolved.chapter;
          if (sectionId !== null) {
            const match = chapter.sections.find((entry) => entry.sectionId === sectionId);
            if (match === undefined) {
              // No fallback by number or by title: a section belongs to exactly one chapter,
              // and a plausible-looking wrong section is worse than a refusal.
              entryIssues.push(`unknown section "${sectionId}" in chapter "${chapterId}"`);
            } else {
              section = match;
            }
          }
        }
        if (catalog.status !== candidate.status) {
          entryIssues.push(
            `status "${String(candidate.status)}" must match its catalog's status "${catalog.status}"`,
          );
        }
      }
    }

    if (
      catalog !== undefined &&
      book !== undefined &&
      chapter !== undefined &&
      isPositiveInteger(candidate.order) &&
      // A section that could not be resolved is already an error; do not also claim its slot.
      (sectionId === null || section !== null)
    ) {
      const positionKey = `${catalog.catalogId}/${book.bookId}/${chapter.chapterId}/${sectionId ?? '-'}/${String(candidate.order)}`;
      // Shared across tools: a chapter may host several tools, but not two at the same slot,
      // and the same holds inside one section.
      const owner = uniqueness.chapterPositions.get(positionKey);
      if (owner !== undefined) {
        entryIssues.push(
          section === null
            ? `tool order ${String(candidate.order)} is already used by "${owner}" in chapter "${chapter.chapterId}"`
            : `tool order ${String(candidate.order)} is already used by "${owner}" in section "${sectionId ?? ''}"`,
        );
      } else {
        uniqueness.chapterPositions.set(positionKey, placementId);
      }
    }

    const idOwner = uniqueness.placementIds.get(placementId);
    if (placementId !== '' && idOwner !== undefined) {
      entryIssues.push(`duplicate placementId "${placementId}" (also declared by [${idOwner}])`);
    }
    const slugOwner = uniqueness.slugs.get(slug);
    if (slug !== '' && slugOwner !== undefined) {
      entryIssues.push(`duplicate placement slug "${slug}" (also declared by [${slugOwner}])`);
    }

    if (entryIssues.length > 0) {
      for (const issue of entryIssues) issues.push(`${where}: ${issue}`);
      return;
    }

    uniqueness.placementIds.set(placementId, folder);
    uniqueness.slugs.set(slug, folder);
    placements.push({
      placementId,
      slug,
      experimentId,
      version: candidate.version as number,
      status: candidate.status as PlacementStatus,
      catalogId,
      bookId,
      chapterId,
      sectionId,
      subject: (catalog as CurriculumCatalog).subject,
      order: candidate.order as number,
      catalog: {
        id: (catalog as CurriculumCatalog).catalogId,
        labels: (catalog as CurriculumCatalog).labels,
      },
      book: { id: (book as CurriculumBook).bookId, labels: (book as CurriculumBook).labels },
      chapter: {
        id: (chapter as CurriculumChapter).chapterId,
        labels: (chapter as CurriculumChapter).labels,
      },
      section:
        section === null ? null : { id: section.sectionId, labels: section.labels },
      title: title as Record<PlacementLocale, string>,
      summary: summary as Record<PlacementLocale, string>,
      preset: preset as Record<string, StateValue>,
      stateSchemaVersion: stateSchema === null ? 0 : stateSchema.version,
    });
  });

  // Directory order is catalog → book → chapter → section → tool order. Nothing else may
  // decide it. A chapter-level entry sorts before the sections of that chapter (section order
  // 0), because it belongs to the chapter itself rather than to a printed section.
  placements.sort((left, right) => {
    const leftCatalog = catalogs.get(left.catalogId);
    const rightCatalog = catalogs.get(right.catalogId);
    const catalogDelta = (leftCatalog?.order ?? 0) - (rightCatalog?.order ?? 0);
    if (catalogDelta !== 0) return catalogDelta;
    if (left.catalogId !== right.catalogId) return left.catalogId.localeCompare(right.catalogId);
    const leftBook = leftCatalog?.books.find((entry) => entry.bookId === left.bookId);
    const rightBook = rightCatalog?.books.find((entry) => entry.bookId === right.bookId);
    const bookDelta = (leftBook?.order ?? 0) - (rightBook?.order ?? 0);
    if (bookDelta !== 0) return bookDelta;
    if (left.bookId !== right.bookId) return left.bookId.localeCompare(right.bookId);
    const leftChapter = leftBook?.chapters.find((entry) => entry.chapterId === left.chapterId);
    const rightChapter = rightBook?.chapters.find((entry) => entry.chapterId === right.chapterId);
    const chapterDelta = (leftChapter?.order ?? 0) - (rightChapter?.order ?? 0);
    if (chapterDelta !== 0) return chapterDelta;
    if (left.chapterId !== right.chapterId) return left.chapterId.localeCompare(right.chapterId);
    const leftSection = leftChapter?.sections.find((entry) => entry.sectionId === left.sectionId);
    const rightSection = rightChapter?.sections.find(
      (entry) => entry.sectionId === right.sectionId,
    );
    const sectionDelta = (leftSection?.order ?? 0) - (rightSection?.order ?? 0);
    if (sectionDelta !== 0) return sectionDelta;
    if (left.sectionId !== right.sectionId) {
      return (left.sectionId ?? '').localeCompare(right.sectionId ?? '');
    }
    if (left.order !== right.order) return left.order - right.order;
    return left.placementId.localeCompare(right.placementId);
  });

  return { placements, issues };
}
