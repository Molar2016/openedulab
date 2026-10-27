#!/usr/bin/env node
/**
 * Content validation for CI: manifest schema, unique routes, SDK compatibility, locale
 * completeness and UI translation parity. Fails with an actionable list, not a stack.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SOURCE_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** `OEL_VALIDATE_ROOT` lets tests point the same rules at a throwaway repository fixture. */
const ROOT = process.env.OEL_VALIDATE_ROOT ? resolve(process.env.OEL_VALIDATE_ROOT) : SOURCE_ROOT;
const EXPERIMENTS_DIR = join(ROOT, 'experiments');
const UI_LOCALES_DIR = join(ROOT, 'apps/web/src/i18n/locales');

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SUPPORTED_LOCALES = ['zh-CN', 'en'];
const PLACEMENT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const PLACEMENT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** `curriculum.json` is placements only (ADR-005). */
const CURRICULUM_SCHEMA_VERSION = 3;
/** One `curricula/<subject>/<file>.json` document. */
const CATALOG_SCHEMA_VERSION = 1;
/** Edition lines the interface has a sentence for (ADR-006). */
const CATALOG_EDITION_STATUS = ['current-2022', 'legacy-2011'];
/** School stages the interface has a label for (teacher navigation A). */
const CATALOG_STAGE = ['primary', 'middle', 'high'];

const errors = [];

function fail(message) {
  errors.push(message);
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`${label}: cannot read/parse JSON (${error.message})`);
    return null;
  }
}

async function hostSdkVersion() {
  const contract = await readFile(join(ROOT, 'apps/web/src/experiment/contract.ts'), 'utf8');
  const match = /SDK_VERSION\s*=\s*'([^']+)'/.exec(contract);
  if (!match) {
    fail('apps/web/src/experiment/contract.ts: SDK_VERSION not found');
    return null;
  }
  return match[1];
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

async function validateExperiment(
  folder,
  hostMajor,
  seenIds,
  seenSlugs,
  seenPlacementIds,
  seenPlacementSlugs,
  catalogs,
  chapterPositions,
) {
  const dir = join(EXPERIMENTS_DIR, folder);
  const manifestPath = join(dir, 'manifest.json');
  const manifest = await readJson(manifestPath, `${folder}/manifest.json`);
  if (!manifest) return null;

  if (!ID.test(manifest.id ?? '')) fail(`${folder}: id "${manifest.id}" must look like "math.functions"`);
  if (!SLUG.test(manifest.slug ?? '')) fail(`${folder}: slug "${manifest.slug}" must be kebab-case`);
  if (!SEMVER.test(manifest.moduleVersion ?? '')) fail(`${folder}: moduleVersion "${manifest.moduleVersion}" must be semver`);
  if (!SEMVER.test(manifest.contentVersion ?? '')) {
    fail(`${folder}: contentVersion "${manifest.contentVersion}" must be semver (server index requires it)`);
  }

  const range = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.sdkVersionRange ?? '');
  if (!range) {
    fail(`${folder}: sdkVersionRange "${manifest.sdkVersionRange}" must be a caret range like "^1.0.0"`);
  } else if (Number(range[1]) !== hostMajor) {
    fail(`${folder}: sdkVersionRange ${manifest.sdkVersionRange} is incompatible with host SDK major ${hostMajor}`);
  }

  for (const key of ['titleKey', 'descriptionKey']) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') fail(`${folder}: ${key} must be a non-empty string`);
  }
  for (const key of ['subjects', 'grades', 'concepts']) {
    if (!isNonEmptyStringArray(manifest[key])) fail(`${folder}: ${key} must be a non-empty string array`);
  }
  if (!Array.isArray(manifest.languages) || manifest.languages.length === 0) {
    fail(`${folder}: languages must be a non-empty array`);
  } else {
    for (const locale of SUPPORTED_LOCALES) {
      if (!manifest.languages.includes(locale)) fail(`${folder}: languages must include "${locale}"`);
    }
  }
  if (typeof manifest.offlineSupport !== 'boolean') fail(`${folder}: offlineSupport must be boolean`);
  if (!['draft', 'verified'].includes(manifest.reviewedStatus)) fail(`${folder}: reviewedStatus must be draft or verified`);

  if (seenIds.has(manifest.id)) fail(`${folder}: duplicate id "${manifest.id}" (also in ${seenIds.get(manifest.id)})`);
  else seenIds.set(manifest.id, folder);
  if (seenSlugs.has(manifest.slug)) fail(`${folder}: duplicate slug "${manifest.slug}" (also in ${seenSlugs.get(manifest.slug)})`);
  else seenSlugs.set(manifest.slug, folder);

  for (const file of ['view.tsx', 'model.ts']) {
    try {
      const info = await stat(join(dir, file));
      if (!info.isFile()) fail(`${folder}: ${file} is not a file`);
    } catch {
      fail(`${folder}: missing ${file}`);
    }
  }

  const localeFiles = [];
  for (const locale of manifest.languages ?? []) {
    const path = join(dir, 'locales', `${locale}.json`);
    const dictionary = await readJson(path, `${folder}/locales/${locale}.json`);
    if (!dictionary) continue;
    localeFiles.push(locale);
    for (const key of [manifest.titleKey, manifest.descriptionKey]) {
      if (typeof dictionary[key] !== 'string' || dictionary[key].trim() === '') {
        fail(`${folder}/locales/${locale}.json: missing non-empty "${key}"`);
      }
    }
  }
  let stateSchema = null;
  try {
    stateSchema = JSON.parse(await readFile(join(dir, 'state-schema.json'), 'utf8'));
  } catch {
    stateSchema = null;
  }
  const placements = await validateCurriculum(
    folder,
    dir,
    manifest,
    stateSchema,
    catalogs,
    chapterPositions,
    seenPlacementIds,
    seenPlacementSlugs,
  );

  return { id: manifest.id, slug: manifest.slug, localeFiles, placements };
}

// Shared helpers for the catalog tree and the placement files below.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInt = (value) => Number.isInteger(value) && value >= 1;

/** Returns a message when the localized pair is unusable, `null` when it is fine. */
function localizedProblem(value, label) {
  if (!isObject(value)) return `${label} must be an object with "zh-CN" and "en"`;
  for (const locale of SUPPORTED_LOCALES) {
    if (typeof value[locale] !== 'string' || value[locale].trim() === '') {
      return `${label}.${locale} must be a non-empty string`;
    }
  }
  const extra = Object.keys(value).filter((key) => !SUPPORTED_LOCALES.includes(key));
  if (extra.length > 0) return `${label} has unknown locales: ${extra.join(', ')}`;
  return null;
}

/**
 * Shared subject-level catalogs (ADR-005): `curricula/<subject>/<file>.json`.
 *
 * Mirrors the server's startup rules for the tree itself: one subject per file, every catalog
 * repeats that subject, a `verified` catalog must name publisher and edition while an
 * `illustrative` one must not, and the orders a directory relies on are unique — book order
 * inside a catalog, chapter order inside a book, chapter id inside a catalog, catalog id and
 * catalog order inside a subject (across files). Nothing here reads a tool file: the tree is
 * validated on its own, which is exactly what "a chapter with no tool still exists" needs.
 */
async function validateCatalogFiles() {
  const curriculaDir = join(ROOT, 'curricula');
  const catalogs = new Map();
  const catalogOrders = new Map();
  const summary = [];

  let subjectDirs;
  try {
    subjectDirs = (await readdir(curriculaDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { catalogs, count: 0, summary: 'none (no curricula/ directory)', chapters: 0, sections: 0 };
    }
    fail(`curricula/: cannot read directory (${error.message})`);
    return { catalogs, count: 0, summary: 'unreadable', chapters: 0, sections: 0 };
  }

  for (const subject of subjectDirs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(subject)) {
      fail(`curricula/${subject}: subject directory must be a tag like "math"`);
      continue;
    }
    let files;
    try {
      files = (await readdir(join(curriculaDir, subject)))
        .filter((file) => file.endsWith('.json'))
        .sort();
    } catch (error) {
      fail(`curricula/${subject}: cannot read directory (${error.message})`);
      continue;
    }
    for (const file of files) {
      const prefix = `curricula/${subject}/${file}`;
      let raw;
      try {
        raw = JSON.parse(await readFile(join(curriculaDir, subject, file), 'utf8'));
      } catch (error) {
        fail(`${prefix}: cannot read/parse JSON (${error.message})`);
        continue;
      }
      if (!isObject(raw)) {
        fail(`${prefix}: must be a JSON object`);
        continue;
      }
      for (const key of Object.keys(raw)) {
        if (!['schemaVersion', 'subject', 'catalogs', 'note'].includes(key)) {
          fail(`${prefix}: unknown top-level key "${key}"`);
        }
      }
      if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) {
        fail(`${prefix}: schemaVersion must be ${CATALOG_SCHEMA_VERSION}`);
      }
      if (raw.subject !== subject) {
        fail(
          `${prefix}: declares subject ${JSON.stringify(raw.subject)} but lives in the "${subject}" directory: a catalog file may only describe its own subject`,
        );
      }
      if (raw.note !== undefined && typeof raw.note !== 'string') {
        fail(`${prefix}: note must be a string`);
      }
      if (!Array.isArray(raw.catalogs) || raw.catalogs.length === 0) {
        fail(`${prefix}: catalogs must be a non-empty array`);
        continue;
      }

      let found = 0;
      for (const [index, entry] of raw.catalogs.entries()) {
        const where = `${prefix} catalogs[${index}]`;
        const issues = [];
        if (!isObject(entry)) {
          fail(`${where}: must be an object`);
          continue;
        }
        for (const key of Object.keys(entry)) {
          if (
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
            ].includes(key)
          ) {
            issues.push(`unknown key "${key}"`);
          }
        }
        if (!PLACEMENT_SLUG.test(entry.catalogId ?? '')) {
          issues.push(`catalogId "${entry.catalogId}" must be kebab-case`);
        }
        if (entry.subject !== subject) {
          issues.push(`subject ${JSON.stringify(entry.subject)} must match this file's subject "${subject}"`);
        }
        if (!positiveInt(entry.version)) issues.push('version must be an integer >= 1');
        if (!['illustrative', 'verified'].includes(entry.status)) {
          issues.push('status must be "illustrative" or "verified"');
        }
        if (!positiveInt(entry.order)) issues.push('catalog order must be an integer >= 1');
        const labelProblem = localizedProblem(entry.label, `${where}.label`);
        if (labelProblem) issues.push(labelProblem);
        if (entry.status === 'verified') {
          if (entry.publisher === undefined) issues.push('a verified catalog must name its publisher');
          else {
            const problem = localizedProblem(entry.publisher, `${where}.publisher`);
            if (problem) issues.push(problem);
          }
          if (entry.revision === undefined) issues.push('a verified catalog must name its revision/edition');
          else {
            const problem = localizedProblem(entry.revision, `${where}.revision`);
            if (problem) issues.push(problem);
          }
        } else if (entry.publisher !== undefined || entry.revision !== undefined) {
          issues.push('an illustrative catalog must not declare publisher or revision');
        }
        if (entry.editionStatus !== undefined) {
          if (
            typeof entry.editionStatus !== 'string' ||
            !CATALOG_EDITION_STATUS.includes(entry.editionStatus)
          ) {
            issues.push(
              `editionStatus ${JSON.stringify(entry.editionStatus)} must be one of ${CATALOG_EDITION_STATUS.map((value) => `"${value}"`).join(', ')}`,
            );
          }
          if (entry.status === 'illustrative') {
            issues.push(
              'an illustrative catalog must not declare an edition status: a sample is not a printed edition',
            );
          }
        }

        if (entry.stage !== undefined) {
          if (typeof entry.stage !== 'string' || !CATALOG_STAGE.includes(entry.stage)) {
            issues.push(
              `stage ${JSON.stringify(entry.stage)} must be one of ${CATALOG_STAGE.map((value) => `"${value}"`).join(', ')}`,
            );
          }
        }

        const books = [];
        if (!Array.isArray(entry.books) || entry.books.length === 0) {
          issues.push('books must be a non-empty array');
        } else {
          const bookIds = new Set();
          const bookOrders = new Map();
          const chapterIds = new Set();
          for (const [bookIndex, book] of entry.books.entries()) {
            const bookWhere = `${where}.books[${bookIndex}]`;
            if (!isObject(book)) {
              issues.push(`${bookWhere} must be an object`);
              continue;
            }
            for (const key of Object.keys(book)) {
              if (!['bookId', 'order', 'label', 'chapters'].includes(key)) {
                issues.push(`${bookWhere} has unknown key "${key}"`);
              }
            }
            if (!PLACEMENT_SLUG.test(book.bookId ?? '')) {
              issues.push(`${bookWhere}.bookId must be kebab-case`);
            }
            if (!positiveInt(book.order)) issues.push(`${bookWhere} book order must be an integer >= 1`);
            const bookLabelProblem = localizedProblem(book.label, `${bookWhere}.label`);
            if (bookLabelProblem) issues.push(bookLabelProblem);
            if (bookIds.has(book.bookId)) issues.push(`duplicate bookId "${book.bookId}"`);
            bookIds.add(book.bookId);
            if (bookOrders.has(book.order)) {
              issues.push(`book order ${book.order} is already used by "${bookOrders.get(book.order)}"`);
            }
            bookOrders.set(book.order, book.bookId);

            const chapters = [];
            if (!Array.isArray(book.chapters) || book.chapters.length === 0) {
              issues.push(`${bookWhere}.chapters must be a non-empty array`);
            } else {
              const chapterOrders = new Map();
              for (const [chapterIndex, chapter] of book.chapters.entries()) {
                const chapterWhere = `${bookWhere}.chapters[${chapterIndex}]`;
                if (!isObject(chapter)) {
                  issues.push(`${chapterWhere} must be an object`);
                  continue;
                }
                for (const key of Object.keys(chapter)) {
                  if (!['chapterId', 'order', 'label', 'printedPage', 'sections'].includes(key)) {
                    issues.push(`${chapterWhere} has unknown key "${key}"`);
                  }
                }
                if (!PLACEMENT_SLUG.test(chapter.chapterId ?? '')) {
                  issues.push(`${chapterWhere}.chapterId must be kebab-case`);
                }
                if (!positiveInt(chapter.order)) {
                  issues.push(`${chapterWhere} chapter order must be an integer >= 1`);
                }
                if (chapter.printedPage !== undefined && !positiveInt(chapter.printedPage)) {
                  issues.push(
                    `${chapterWhere}.printedPage must be a positive integer (the page printed in the book)`,
                  );
                }
                const chapterLabelProblem = localizedProblem(chapter.label, `${chapterWhere}.label`);
                if (chapterLabelProblem) issues.push(chapterLabelProblem);
                if (chapterIds.has(chapter.chapterId)) {
                  issues.push(`duplicate chapterId "${chapter.chapterId}" in catalog "${entry.catalogId}"`);
                }
                chapterIds.add(chapter.chapterId);
                if (chapterOrders.has(chapter.order)) {
                  issues.push(
                    `chapter order ${chapter.order} is already used by "${chapterOrders.get(chapter.order)}" in book "${book.bookId}"`,
                  );
                }
                chapterOrders.set(chapter.order, chapter.chapterId);

                // Sections (ADR-006): a chapter may publish the printed sections it contains.
                // Absent is legitimate (a chapters-only catalog); present must be usable.
                if (chapter.sections !== undefined) {
                  if (!Array.isArray(chapter.sections)) {
                    issues.push(`${chapterWhere}.sections must be an array`);
                  } else {
                    const sectionIds = new Set();
                    const sectionOrders = new Map();
                    for (const [sectionIndex, section] of chapter.sections.entries()) {
                      const sectionWhere = `${chapterWhere}.sections[${sectionIndex}]`;
                      if (!isObject(section)) {
                        issues.push(`${sectionWhere} must be an object`);
                        continue;
                      }
                      for (const key of Object.keys(section)) {
                        if (!['sectionId', 'order', 'label', 'printedPage'].includes(key)) {
                          issues.push(`${sectionWhere} has unknown key "${key}"`);
                        }
                      }
                      if (!PLACEMENT_SLUG.test(section.sectionId ?? '')) {
                        issues.push(`${sectionWhere}.sectionId must be kebab-case`);
                      }
                      if (!positiveInt(section.order)) {
                        issues.push(`${sectionWhere} section order must be an integer >= 1`);
                      }
                      if (section.printedPage !== undefined && !positiveInt(section.printedPage)) {
                        issues.push(
                          `${sectionWhere}.printedPage must be a positive integer (the page printed in the book)`,
                        );
                      }
                      const sectionLabelProblem = localizedProblem(
                        section.label,
                        `${sectionWhere}.label`,
                      );
                      if (sectionLabelProblem) issues.push(sectionLabelProblem);
                      if (sectionIds.has(section.sectionId)) {
                        issues.push(
                          `duplicate sectionId "${section.sectionId}" in chapter "${chapter.chapterId}" (two sections would share one entry point)`,
                        );
                      }
                      sectionIds.add(section.sectionId);
                      if (sectionOrders.has(section.order)) {
                        issues.push(
                          `section order ${section.order} is already used by "${sectionOrders.get(section.order)}" in chapter "${chapter.chapterId}"`,
                        );
                      }
                      sectionOrders.set(section.order, section.sectionId);
                    }
                  }
                }
                chapters.push(chapter);
              }
            }
            books.push({ ...book, chapters });
          }
        }

        if (issues.length === 0 && positiveInt(entry.order)) {
          if (catalogs.has(entry.catalogId)) {
            issues.push(
              `duplicate catalogId "${entry.catalogId}" (also declared by ${catalogs.get(entry.catalogId).source})`,
            );
          }
          const orderKey = `${subject}/${entry.order}`;
          if (catalogOrders.has(orderKey)) {
            issues.push(
              `catalog order ${entry.order} is already used by "${catalogOrders.get(orderKey).catalogId}" (in ${catalogOrders.get(orderKey).source})`,
            );
          }
        }

        for (const issue of issues) fail(`${where}: ${issue}`);
        if (issues.length === 0) {
          catalogs.set(entry.catalogId, { ...entry, books, source: prefix });
          catalogOrders.set(`${subject}/${entry.order}`, { catalogId: entry.catalogId, source: prefix });
          found += 1;
        }
      }
      if (found > 0) summary.push(`${prefix} (${found})`);
    }
  }

  let chapters = 0;
  let sections = 0;
  for (const catalog of catalogs.values()) {
    for (const book of catalog.books ?? []) {
      chapters += (book.chapters ?? []).length;
      for (const chapter of book.chapters ?? []) {
        sections += (chapter.sections ?? []).length;
      }
    }
  }

  return {
    catalogs,
    count: catalogs.size,
    summary: summary.join('; ') || 'none',
    chapters,
    sections,
  };
}

/**
 * One tool's `curriculum.json`: placements only (ADR-005). The chapters they reference live
 * in the shared catalog tree, so a chapter with no tool is simply not mentioned here — and a
 * reference that no catalog answers is an error, never a silent "no tools in this chapter".
 */
async function validateCurriculum(
  folder,
  dir,
  manifest,
  stateSchema,
  catalogs,
  chapterPositions,
  seenIds,
  seenSlugs,
) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(dir, 'curriculum.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { placements: 0 };
    fail(`${folder}/curriculum.json: cannot read/parse JSON (${error.message})`);
    return { placements: 0 };
  }
  const prefix = `${folder}/curriculum.json`;

  if (!isObject(raw)) {
    fail(`${prefix}: must be a JSON object`);
    return { placements: 0 };
  }
  for (const key of Object.keys(raw)) {
    if (!['schemaVersion', 'placements', 'note'].includes(key)) {
      fail(`${prefix}: unknown top-level key "${key}"`);
    }
  }
  if (raw.catalogs !== undefined) {
    fail(
      `${prefix}: may not declare catalogs: the textbook tree lives in curricula/<subject>/<file>.json (ADR-005) and this file carries placements that reference it`,
    );
  }
  if (raw.schemaVersion !== CURRICULUM_SCHEMA_VERSION) {
    fail(`${prefix}: schemaVersion must be ${CURRICULUM_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.placements)) {
    fail(`${prefix}: placements must be an array`);
    return { placements: 0 };
  }

  let indexedPlacements = 0;
  for (const [index, entry] of raw.placements.entries()) {
    const where = `${prefix} placements[${index}]`;
    const issues = [];
    if (!isObject(entry)) {
      fail(`${where}: must be an object`);
      continue;
    }
    const allowed = [
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
    ];
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) issues.push(`unknown key "${key}"`);
    }
    if (!PLACEMENT_ID.test(entry.placementId ?? '')) {
      issues.push(`placementId "${entry.placementId}" must look like "${manifest.id}.<chapter>"`);
    } else if (!entry.placementId.startsWith(`${manifest.id}.`)) {
      issues.push(`placementId "${entry.placementId}" must start with "${manifest.id}."`);
    }
    if (!PLACEMENT_SLUG.test(entry.slug ?? '')) {
      issues.push(`slug "${entry.slug}" must be kebab-case`);
    }
    if (!positiveInt(entry.version)) issues.push('version must be an integer >= 1');
    if (!positiveInt(entry.order)) issues.push('tool order must be an integer >= 1');
    if (!['illustrative', 'verified'].includes(entry.status)) {
      issues.push('status must be "illustrative" or "verified"');
    }
    for (const key of ['catalogId', 'bookId', 'chapterId']) {
      if (!PLACEMENT_SLUG.test(entry[key] ?? '')) issues.push(`${key} "${entry[key]}" must be kebab-case`);
    }
    if (entry.sectionId !== undefined && !PLACEMENT_SLUG.test(entry.sectionId ?? '')) {
      issues.push(`sectionId "${entry.sectionId}" must be kebab-case`);
    }
    for (const text of ['title', 'summary']) {
      const problem = localizedProblem(entry[text], `${where}.${text}`);
      if (problem) issues.push(problem);
    }

    const catalog = catalogs.get(entry.catalogId);
    if (catalog === undefined) {
      issues.push(
        `unknown catalog "${entry.catalogId}": no curricula/<subject>/*.json declares it (a placement may only reference a shared catalog)`,
      );
    } else if (!(manifest.subjects ?? []).includes(catalog.subject)) {
      issues.push(
        `catalog "${entry.catalogId}" belongs to subject "${catalog.subject}", which is not one of this tool's manifest subjects`,
      );
    } else {
      const book = (catalog.books ?? []).find((candidate) => candidate.bookId === entry.bookId);
      if (book === undefined) {
        issues.push(`unknown book "${entry.bookId}" in catalog "${entry.catalogId}"`);
      } else {
        const chapter = (book.chapters ?? []).find(
          (candidate) => candidate.chapterId === entry.chapterId,
        );
        if (chapter === undefined) {
          const otherBook = (catalog.books ?? []).find((candidate) =>
            (candidate.chapters ?? []).some(
              (candidateChapter) => candidateChapter.chapterId === entry.chapterId,
            ),
          );
          issues.push(
            otherBook
              ? `chapter "${entry.chapterId}" belongs to book "${otherBook.bookId}", not "${entry.bookId}"`
              : `unknown chapter "${entry.chapterId}" in catalog "${entry.catalogId}"`,
          );
        } else if (positiveInt(entry.order)) {
          // A placement may name a printed section (ADR-006). Resolution is exact: the section
          // must belong to the chapter this placement names, never matched by number or title.
          const chapterSections = Array.isArray(chapter.sections) ? chapter.sections : [];
          const section =
            entry.sectionId === undefined
              ? null
              : chapterSections.find((candidate) => candidate.sectionId === entry.sectionId);
          if (entry.sectionId !== undefined && section === undefined) {
            issues.push(
              `unknown section "${entry.sectionId}" in chapter "${entry.chapterId}"`,
            );
          } else {
            const positionKey = `${entry.catalogId}/${entry.bookId}/${entry.chapterId}/${entry.sectionId ?? '-'}/${entry.order}`;
            if (chapterPositions.has(positionKey)) {
              issues.push(
                entry.sectionId === undefined
                  ? `tool order ${entry.order} is already used by "${chapterPositions.get(positionKey)}" in chapter "${entry.chapterId}"`
                  : `tool order ${entry.order} is already used by "${chapterPositions.get(positionKey)}" in section "${entry.sectionId}"`,
              );
            } else {
              chapterPositions.set(positionKey, entry.placementId);
            }
          }
        }
      }
      if (entry.status !== catalog.status) {
        issues.push(`status "${entry.status}" must match its catalog's status "${catalog.status}"`);
      }
    }

    if (stateSchema === null) {
      issues.push('declares a preset but the experiment has no state-schema.json');
    } else {
      const fields = stateSchema.fields ?? {};
      const preset = entry.preset ?? {};
      const given = Object.keys(preset);
      const declared = Object.keys(fields);
      for (const key of given) {
        if (!declared.includes(key)) issues.push(`preset has unknown parameter "${key}"`);
      }
      for (const key of declared) {
        if (!given.includes(key)) issues.push(`preset is missing parameter "${key}"`);
        const field = fields[key];
        const value = preset[key];
        if (value === undefined) continue;
        if (field.kind === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            issues.push(`preset.${key} must be a number`);
          } else if (value < field.min || value > field.max) {
            issues.push(`preset.${key} is outside [${field.min}, ${field.max}]`);
          } else if (
            Math.abs((value - field.min) / field.step - Math.round((value - field.min) / field.step)) > 1e-6
          ) {
            issues.push(`preset.${key} is not on step ${field.step}`);
          }
        } else if (!Array.isArray(field.values) || !field.values.includes(value)) {
          issues.push(`preset.${key} must be one of ${JSON.stringify(field.values)}`);
        }
      }
    }

    const previousId = seenIds.get(entry.placementId);
    if (previousId) issues.push(`duplicate placementId "${entry.placementId}" (also in ${previousId})`);
    const previousSlug = seenSlugs.get(entry.slug);
    if (previousSlug) issues.push(`duplicate placement slug "${entry.slug}" (also in ${previousSlug})`);

    for (const issue of issues) fail(`${where}: ${issue}`);
    if (issues.length === 0) {
      seenIds.set(entry.placementId, folder);
      seenSlugs.set(entry.slug, folder);
      indexedPlacements += 1;
    }
  }

  return { placements: indexedPlacements };
}

async function validateUiLocales() {
  const dictionaries = {};
  for (const locale of SUPPORTED_LOCALES) {
    const dictionary = await readJson(join(UI_LOCALES_DIR, `${locale}.json`), `ui locales/${locale}.json`);
    if (!dictionary) continue;
    dictionaries[locale] = dictionary;
    for (const [key, value] of Object.entries(dictionary)) {
      if (typeof value !== 'string' || value.trim() === '') fail(`ui locales/${locale}.json: "${key}" is empty`);
    }
  }
  const englishKeys = Object.keys(dictionaries.en ?? {}).sort();
  const chineseKeys = Object.keys(dictionaries['zh-CN'] ?? {}).sort();
  for (const key of englishKeys) {
    if (!chineseKeys.includes(key)) fail(`ui i18n: "zh-CN" is missing key "${key}"`);
  }
  for (const key of chineseKeys) {
    if (!englishKeys.includes(key)) fail(`ui i18n: "en" is missing key "${key}"`);
  }
  return { locales: Object.keys(dictionaries), keys: englishKeys.length };
}

async function main() {
  const hostVersion = await hostSdkVersion();
  if (!hostVersion) return report();
  const hostMajor = Number(hostVersion.split('.')[0]);

  const entries = await readdir(EXPERIMENTS_DIR, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (folders.length === 0) fail('experiments/: no experiment folders found');

  const seenIds = new Map();
  const seenSlugs = new Map();
  const seenPlacementIds = new Map();
  const seenPlacementSlugs = new Map();
  // The tree is loaded before the tools: a placement resolves against it, never the other
  // way round. `chapterPositions` spans every tool, so two tools cannot claim one slot.
  const catalogTree = await validateCatalogFiles();
  const chapterPositions = new Map();
  const experiments = [];
  for (const folder of folders) {
    const result = await validateExperiment(
      folder,
      hostMajor,
      seenIds,
      seenSlugs,
      seenPlacementIds,
      seenPlacementSlugs,
      catalogTree.catalogs,
      chapterPositions,
    );
    if (result) experiments.push(result);
  }

  const ui = await validateUiLocales();

  if (experiments.length !== folders.length) {
    fail(`experiments/: ${folders.length} folders but ${experiments.length} valid manifests`);
  }

  if (errors.length > 0) {
    console.error(`Content validation failed (${errors.length}):`);
    for (const error of errors) console.error(` - ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Content validation OK`);
  console.log(` - experiments: ${experiments.map((entry) => `${entry.id} (slug: ${entry.slug}, locales: ${entry.localeFiles.join(', ')})`).join('; ')}`);
  console.log(
    ` - curriculum catalogs: ${catalogTree.count} (${catalogTree.summary})`,
  );
  console.log(` - curriculum tree: ${catalogTree.chapters} chapters, ${catalogTree.sections} sections`);
  console.log(
    ` - curriculum placements: ${experiments
      .map((entry) => `${entry.id}: ${entry.placements.placements}`)
      .join('; ')}`,
  );
  console.log(` - UI dictionaries: ${ui.locales.join(', ')} with ${ui.keys} keys each`);
  console.log(` - host SDK: ${hostVersion}`);
}

function report() {
  if (errors.length > 0) {
    console.error('Content validation failed');
    process.exitCode = 1;
  }
}

await main();
