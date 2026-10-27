import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  createPlacementUniqueness,
  parseCatalogFile,
  parseCurriculum,
  SUBJECT_TAG,
  type CurriculumCatalog,
  type CurriculumPlacement,
  type PlacementParseResult,
} from './curriculum.js';
import { parseStateSchema, type StateSchema } from './state-validator.js';

/**
 * Server-side content index (design §7.2, D10).
 *
 * The experiment manifests shipped in `experiments/<folder>/manifest.json` are the only
 * source of truth for the catalog. They are read once at startup, validated as a whole,
 * and the process refuses to start when the index is inconsistent — a broken manifest
 * must never turn into "the catalog silently lost an experiment".
 *
 * This module never exposes a filesystem path to a client, and never serves a file
 * directly: routes return the indexed, already-validated fields.
 */

export const HOST_SDK_VERSION = '1.0.0';
export const CONTENT_LOCALES = ['zh-CN', 'en'] as const;
export type ContentLocale = (typeof CONTENT_LOCALES)[number];

const EXPERIMENT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const CARET = /^\^(\d+)\.(\d+)\.(\d+)$/;
const MAX_CATALOG_ITEMS = 50;

export interface ContentText {
  readonly title: string;
  readonly description: string;
}

export interface ContentExperiment {
  readonly id: string;
  readonly slug: string;
  readonly moduleVersion: string;
  readonly contentVersion: string;
  readonly sdkVersionRange: string;
  readonly reviewedStatus: 'draft' | 'verified';
  readonly subjects: readonly string[];
  readonly grades: readonly string[];
  readonly concepts: readonly string[];
  readonly languages: readonly ContentLocale[];
  readonly offlineSupport: boolean;
  /** Manifest file mtime: lets a client tell that content changed without a version bump. */
  readonly updatedAt: number;
  readonly texts: Readonly<Record<ContentLocale, ContentText>>;
  /**
   * Declared parameter-snapshot schema (design §7.5), or `null` when the experiment does
   * not offer saved settings. Validated at startup like everything else in the index.
   */
  readonly stateSchema: StateSchema | null;
  /** The validated manifest as shipped, for the experiment detail endpoint. */
  readonly manifest: Readonly<Record<string, unknown>>;
  /**
   * Curriculum directory entries that reuse this tool (ADR-003). Empty when the tool has
   * no `curriculum.json`; presets are already validated against `stateSchema`.
   */
  readonly placements: readonly CurriculumPlacement[];
}

export interface CatalogQuery {
  readonly subject?: string;
  readonly grade?: string;
  readonly concept?: string;
  readonly q?: string;
  readonly locale: ContentLocale;
  readonly limit: number;
}

export interface ContentIndex {
  readonly experiments: readonly ContentExperiment[];
  /**
   * Every shared catalog under `curricula/<subject>/`, ordered by subject, catalog order and
   * id. The tree is `subject → catalog → book → chapter`; placements reference
   * chapters by id, and a catalog is published whether or not a tool sits in it.
   */
  readonly catalogs: readonly CurriculumCatalog[];
  /** Every placement across every tool, ordered by catalog, book, chapter and tool order. */
  readonly placements: readonly CurriculumPlacement[];
  find(id: string): ContentExperiment | undefined;
  findPlacement(placementId: string): { placement: CurriculumPlacement; experiment: ContentExperiment } | undefined;
  placementsFor(experimentId: string): readonly CurriculumPlacement[];
  list(query: CatalogQuery): readonly ContentExperiment[];
}

export class ContentIndexError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        'Refusing to start: the content index is invalid.',
        ...issues.map((issue) => `  - ${issue}`),
      ].join('\n'),
    );
    this.name = 'ContentIndexError';
    this.issues = issues;
  }
}

interface ManifestFile {
  readonly folder: string;
  readonly path: string;
  readonly raw: unknown;
  readonly updatedAt: number;
}

function readManifests(contentDir: string, issues: string[]): ManifestFile[] {
  let folders: string[];
  try {
    folders = readdirSync(contentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    issues.push(`cannot read content directory (${(error as Error).message})`);
    return [];
  }

  const manifests: ManifestFile[] = [];
  for (const folder of folders) {
    const path = join(contentDir, folder, 'manifest.json');
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // Folders without a manifest are not experiments (e.g. a stray directory).
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      manifests.push({ folder, path, raw, updatedAt: Math.floor(stat.mtimeMs) });
    } catch (error) {
      issues.push(`[${folder}] manifest.json is not valid JSON (${(error as Error).message})`);
    }
  }

  if (manifests.length === 0) {
    issues.push('no <folder>/manifest.json found; the catalog would be empty');
  }
  return manifests;
}

/**
 * Loads every `curricula/<subject>/<file>.json` document (ADR-005).
 *
 * The textbook tree is subject-level content: it must be published even when no tool is
 * placed in it, and two tools must be able to share one chapter. So it is read on its own,
 * before any experiment, and never derived from a tool's placements.
 *
 * A missing `curricula/` directory is legitimate — a repository may have experiments but no
 * curriculum yet. A present-but-broken file is a startup error like any other: a duplicated
 * catalog id, or two catalogs of one subject claiming the same order, would make the
 * directory order ambiguous, and ambiguity in a teaching directory means a teacher lands in
 * the wrong place without noticing.
 */
function readCatalogFiles(curriculaDir: string, issues: string[]): CurriculumCatalog[] {
  let subjectDirs: string[];
  try {
    subjectDirs = readdirSync(curriculaDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    issues.push(`cannot read curricula directory (${(error as Error).message})`);
    return [];
  }

  const catalogs: CurriculumCatalog[] = [];
  const byId = new Map<string, string>();
  const orderOwners = new Map<string, { catalogId: string; source: string }>();

  for (const subject of subjectDirs) {
    if (!SUBJECT_TAG.test(subject)) {
      issues.push(`[curricula/${subject}] subject directory must be a tag like "math"`);
      continue;
    }
    let files: string[];
    try {
      files = readdirSync(join(curriculaDir, subject))
        .filter((file) => file.endsWith('.json'))
        .sort();
    } catch (error) {
      issues.push(`[curricula/${subject}] cannot read (${(error as Error).message})`);
      continue;
    }
    for (const file of files) {
      const source = `curricula/${subject}/${file}`;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(curriculaDir, subject, file), 'utf8'));
      } catch (error) {
        issues.push(`[${source}] is not valid JSON (${(error as Error).message})`);
        continue;
      }
      const parsed = parseCatalogFile(raw, { source, subject });
      for (const issue of parsed.issues) issues.push(issue);
      for (const catalog of parsed.catalogs) {
        const idOwner = byId.get(catalog.catalogId);
        if (idOwner !== undefined) {
          issues.push(
            `[${source}] duplicate catalogId "${catalog.catalogId}" (also declared by ${idOwner})`,
          );
          continue;
        }
        // Order is scoped to the subject: "the second textbook of math" is a fact of the
        // subject directory, while two subjects may each start at 1.
        const orderKey = `${catalog.subject}/${String(catalog.order)}`;
        const orderOwner = orderOwners.get(orderKey);
        if (orderOwner !== undefined) {
          issues.push(
            `[${source}] catalog order ${String(catalog.order)} is already used by "${orderOwner.catalogId}" (in ${orderOwner.source})`,
          );
          continue;
        }
        byId.set(catalog.catalogId, source);
        orderOwners.set(orderKey, { catalogId: catalog.catalogId, source });
        catalogs.push(catalog);
      }
    }
  }

  return catalogs;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim() !== '')
  );
}

function readTexts(
  contentDir: string,
  folder: string,
  languages: readonly ContentLocale[],
  titleKey: string,
  descriptionKey: string,
  issues: string[],
): Record<ContentLocale, ContentText> {
  const texts = {} as Record<ContentLocale, ContentText>;
  for (const locale of languages) {
    const path = join(contentDir, folder, 'locales', `${locale}.json`);
    let dictionary: unknown;
    try {
      dictionary = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      issues.push(`[${folder}] locales/${locale}.json is missing or unreadable (${(error as Error).message})`);
      continue;
    }
    if (dictionary === null || typeof dictionary !== 'object') {
      issues.push(`[${folder}] locales/${locale}.json must be a JSON object`);
      continue;
    }
    const record = dictionary as Record<string, unknown>;
    const title = record[titleKey];
    const description = record[descriptionKey];
    if (typeof title !== 'string' || title.trim() === '') {
      issues.push(`[${folder}] locales/${locale}.json has no non-empty "${titleKey}"`);
      continue;
    }
    if (typeof description !== 'string' || description.trim() === '') {
      issues.push(`[${folder}] locales/${locale}.json has no non-empty "${descriptionKey}"`);
      continue;
    }
    texts[locale] = { title, description };
  }
  return texts;
}

/**
 * Reads `<folder>/state-schema.json` when present. Absence is legitimate (an experiment
 * without saved settings); a present-but-invalid file is a startup error, because silently
 * disabling the feature would look to a teacher like "my settings disappeared".
 */
function readStateSchema(
  contentDir: string,
  folder: string,
  issues: string[],
): StateSchema | null {
  const path = join(contentDir, folder, 'state-schema.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    issues.push(`[${folder}] state-schema.json is not valid JSON (${(error as Error).message})`);
    return null;
  }
  const parsed = parseStateSchema(raw);
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      issues.push(`[${folder}] state-schema.json: ${issue}`);
    }
    return null;
  }
  return parsed.schema;
}

/**
 * Reads `<folder>/curriculum.json` when present. Absence is legitimate: the tool simply is
 * not placed in the curriculum yet. A present-but-invalid file (or a preset the tool's own
 * schema rejects) is a startup error — a chapter that promises numbers the experiment
 * cannot show would be a lie on the first day of class. The file carries placements only;
 * the chapters they point into come from the shared `curricula/` tree (ADR-005).
 */
function readCurriculum(
  contentDir: string,
  folder: string,
  experimentId: string,
  subjects: readonly string[],
  stateSchema: StateSchema | null,
  catalogs: ReadonlyMap<string, CurriculumCatalog>,
  uniqueness: ReturnType<typeof createPlacementUniqueness>,
  issues: string[],
): PlacementParseResult {
  const path = join(contentDir, folder, 'curriculum.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { placements: [], issues: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    issues.push(`[${folder}] curriculum.json is not valid JSON (${(error as Error).message})`);
    return { placements: [], issues: [] };
  }
  const parsed = parseCurriculum(raw, {
    experimentId,
    subjects,
    stateSchema,
    folder,
    uniqueness,
    catalogs,
  });
  for (const issue of parsed.issues) {
    issues.push(issue.startsWith(`[${folder}]`) ? issue : `[${folder}] ${issue}`);
  }
  return parsed;
}

/**
 * Loads and validates every manifest under `contentDir`. Throws ContentIndexError with
 * the full list of problems rather than returning a partial catalog.
 */
export function loadContentIndex(
  contentDir: string,
  options: { readonly hostSdkVersion?: string; readonly curriculaDir?: string } = {},
): ContentIndex {
  const hostVersion = options.hostSdkVersion ?? HOST_SDK_VERSION;
  const hostMajor = Number(hostVersion.split('.')[0]);
  const issues: string[] = [];
  const experiments: ContentExperiment[] = [];
  const seenIds = new Map<string, string>();
  const seenSlugs = new Map<string, string>();
  const placementUniqueness = createPlacementUniqueness();
  const allPlacements: CurriculumPlacement[] = [];
  // `curricula/` sits next to `experiments/` in the repository, so one deployment path
  // carries both and no extra configuration variable can point them at different trees.
  const curriculaDir = options.curriculaDir ?? join(dirname(contentDir), 'curricula');
  const allCatalogs = readCatalogFiles(curriculaDir, issues);
  const catalogsById = new Map(allCatalogs.map((catalog) => [catalog.catalogId, catalog]));

  for (const file of readManifests(contentDir, issues)) {
    const { folder, raw, updatedAt } = file;
    if (raw === null || typeof raw !== 'object') {
      issues.push(`[${folder}] manifest is not an object`);
      continue;
    }
    const manifest = raw as Record<string, unknown>;
    const id = typeof manifest.id === 'string' ? manifest.id : '';
    const slug = typeof manifest.slug === 'string' ? manifest.slug : '';

    if (!EXPERIMENT_ID.test(id)) {
      issues.push(`[${folder}] id "${id}" must look like "math.functions"`);
      continue;
    }
    if (!SLUG.test(slug)) {
      issues.push(`[${folder}] slug "${slug}" must be kebab-case`);
    }
    if (typeof manifest.moduleVersion !== 'string' || !SEMVER.test(manifest.moduleVersion)) {
      issues.push(`[${folder}] moduleVersion "${String(manifest.moduleVersion)}" is not semver`);
    }
    if (typeof manifest.contentVersion !== 'string' || !SEMVER.test(manifest.contentVersion)) {
      issues.push(
        `[${folder}] contentVersion "${String(manifest.contentVersion)}" is not semver ` +
          '(the content version is what events and saved state are keyed by)',
      );
    }
    const range = typeof manifest.sdkVersionRange === 'string' ? manifest.sdkVersionRange : '';
    const caret = CARET.exec(range);
    if (caret === null) {
      issues.push(`[${folder}] sdkVersionRange "${range}" must be a caret range like "^1.0.0"`);
    } else if (Number(caret[1]) !== hostMajor) {
      issues.push(`[${folder}] sdkVersionRange ${range} is incompatible with host SDK ${hostVersion}`);
    }
    for (const key of ['titleKey', 'descriptionKey']) {
      if (typeof manifest[key] !== 'string' || (manifest[key] as string).trim() === '') {
        issues.push(`[${folder}] ${key} must be a non-empty string`);
      }
    }
    for (const key of ['subjects', 'grades', 'concepts']) {
      if (!isNonEmptyStringArray(manifest[key])) {
        issues.push(`[${folder}] ${key} must be a non-empty string array`);
      }
    }
    const languages = Array.isArray(manifest.languages)
      ? manifest.languages.filter((value): value is ContentLocale =>
          (CONTENT_LOCALES as readonly string[]).includes(value as string),
        )
      : [];
    if (languages.length !== CONTENT_LOCALES.length) {
      issues.push(`[${folder}] languages must include ${CONTENT_LOCALES.join(' and ')}`);
    }
    if (typeof manifest.offlineSupport !== 'boolean') {
      issues.push(`[${folder}] offlineSupport must be a boolean`);
    }
    if (manifest.reviewedStatus !== 'draft' && manifest.reviewedStatus !== 'verified') {
      issues.push(`[${folder}] reviewedStatus must be "draft" or "verified"`);
    }

    const duplicateOf = seenIds.get(id);
    if (duplicateOf !== undefined) {
      issues.push(`[${folder}] duplicate id "${id}" (also declared by [${duplicateOf}])`);
    } else if (id !== '') {
      seenIds.set(id, folder);
    }
    const slugOwner = seenSlugs.get(slug);
    if (slugOwner !== undefined) {
      issues.push(`[${folder}] duplicate slug "${slug}" (also declared by [${slugOwner}])`);
    } else if (slug !== '') {
      seenSlugs.set(slug, folder);
    }

    if (issues.length > 0 && issues.some((issue) => issue.startsWith(`[${folder}]`))) {
      // Keep validating the remaining folders, but never index a folder with problems.
      continue;
    }

    const texts = readTexts(
      contentDir,
      folder,
      languages,
      manifest.titleKey as string,
      manifest.descriptionKey as string,
      issues,
    );
    if (languages.some((locale) => texts[locale] === undefined)) {
      continue;
    }

    const stateSchema = readStateSchema(contentDir, folder, issues);
    if (issues.some((issue) => issue.startsWith(`[${folder}]`))) {
      continue;
    }

    const curriculum = readCurriculum(
      contentDir,
      folder,
      id,
      manifest.subjects as string[],
      stateSchema,
      catalogsById,
      placementUniqueness,
      issues,
    );
    if (issues.some((issue) => issue.startsWith(`[${folder}]`))) {
      continue;
    }
    for (const placement of curriculum.placements) allPlacements.push(placement);

    experiments.push({
      id,
      slug,
      moduleVersion: manifest.moduleVersion as string,
      contentVersion: manifest.contentVersion as string,
      sdkVersionRange: range,
      reviewedStatus: manifest.reviewedStatus as 'draft' | 'verified',
      subjects: [...(manifest.subjects as string[])],
      grades: [...(manifest.grades as string[])],
      concepts: [...(manifest.concepts as string[])],
      languages: [...languages],
      offlineSupport: manifest.offlineSupport as boolean,
      updatedAt,
      texts,
      stateSchema,
      manifest: Object.freeze({ ...manifest }),
      placements: Object.freeze([...curriculum.placements]),
    });
  }

  if (issues.length > 0) {
    throw new ContentIndexError(issues);
  }

  experiments.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const frozen = Object.freeze(experiments);

  // 学科 → 教材 → 册 → 章 → 工具入口. Catalog order is data (`order`), so two catalogs may
  // order the same conceptual chapters differently without any code change. Catalogs with
  // no tool in them stay in this list: an empty chapter is a real state, not a missing row.
  const sortedCatalogs = [...allCatalogs].sort((left, right) => {
    if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1;
    if (left.order !== right.order) return left.order - right.order;
    return left.catalogId.localeCompare(right.catalogId);
  });
  const frozenCatalogs = Object.freeze(sortedCatalogs);
  const sortedCatalogsById = new Map(
    sortedCatalogs.map((catalog) => [catalog.catalogId, catalog]),
  );

  const frozenPlacements = Object.freeze(
    [...allPlacements].sort((left, right) => {
      const leftCatalog = sortedCatalogsById.get(left.catalogId);
      const rightCatalog = sortedCatalogsById.get(right.catalogId);
      if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1;
      const catalogDelta = (leftCatalog?.order ?? 0) - (rightCatalog?.order ?? 0);
      if (catalogDelta !== 0) return catalogDelta;
      if (left.catalogId !== right.catalogId) {
        return left.catalogId < right.catalogId ? -1 : 1;
      }
      const leftBook = leftCatalog?.books.find((entry) => entry.bookId === left.bookId);
      const rightBook = rightCatalog?.books.find((entry) => entry.bookId === right.bookId);
      const bookDelta = (leftBook?.order ?? 0) - (rightBook?.order ?? 0);
      if (bookDelta !== 0) return bookDelta;
      if (left.bookId !== right.bookId) return left.bookId < right.bookId ? -1 : 1;
      const leftChapter = leftBook?.chapters.find((entry) => entry.chapterId === left.chapterId);
      const rightChapter = rightBook?.chapters.find(
        (entry) => entry.chapterId === right.chapterId,
      );
      const chapterDelta = (leftChapter?.order ?? 0) - (rightChapter?.order ?? 0);
      if (chapterDelta !== 0) return chapterDelta;
      if (left.chapterId !== right.chapterId) {
        return left.chapterId < right.chapterId ? -1 : 1;
      }
      // Inside a chapter: the chapter's own entries first, then its sections in book order.
      const leftSection = leftChapter?.sections.find(
        (entry) => entry.sectionId === left.sectionId,
      );
      const rightSection = rightChapter?.sections.find(
        (entry) => entry.sectionId === right.sectionId,
      );
      const sectionDelta = (leftSection?.order ?? 0) - (rightSection?.order ?? 0);
      if (sectionDelta !== 0) return sectionDelta;
      if (left.sectionId !== right.sectionId) {
        return (left.sectionId ?? '') < (right.sectionId ?? '') ? -1 : 1;
      }
      if (left.order !== right.order) return left.order - right.order;
      return left.placementId.localeCompare(right.placementId);
    }),
  );

  return {
    experiments: frozen,
    catalogs: frozenCatalogs,
    placements: frozenPlacements,
    find(id) {
      return frozen.find((entry) => entry.id === id);
    },
    findPlacement(placementId) {
      const placement = frozenPlacements.find((item) => item.placementId === placementId);
      if (placement === undefined) return undefined;
      const experiment = frozen.find((entry) => entry.id === placement.experimentId);
      return experiment === undefined ? undefined : { placement, experiment };
    },
    placementsFor(experimentId) {
      return frozenPlacements.filter((item) => item.experimentId === experimentId);
    },
    list(query) {
      const tokens =
        query.q === undefined
          ? []
          : query.q
              .trim()
              .toLowerCase()
              .split(/\s+/)
              .filter((token) => token !== '');

      const matches = frozen.filter((entry) => {
        if (query.subject !== undefined && !entry.subjects.includes(query.subject)) return false;
        if (query.grade !== undefined && !entry.grades.includes(query.grade)) return false;
        if (query.concept !== undefined && !entry.concepts.includes(query.concept)) return false;
        if (tokens.length === 0) return true;
        const text = entry.texts[query.locale];
        const haystack = [
          text.title,
          text.description,
          entry.id,
          entry.slug,
          ...entry.subjects,
          ...entry.grades,
          ...entry.concepts,
        ]
          .join(' ')
          .toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      });

      return matches.slice(0, Math.min(query.limit, MAX_CATALOG_ITEMS));
    },
  };
}

export { MAX_CATALOG_ITEMS };
