import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Test-only content fixture: writes `experiments/<folder>/manifest.json` plus the two
 * locale dictionaries the server index requires. Kept separate from the real
 * `experiments/` directory so catalog filtering can be exercised with more than one
 * experiment without touching shipped content.
 */

export interface ContentFixtureEntry {
  readonly id: string;
  readonly slug: string;
  readonly titleEn: string;
  readonly titleZh: string;
  readonly descriptionEn?: string;
  readonly descriptionZh?: string;
  readonly moduleVersion?: string;
  readonly contentVersion?: string;
  readonly subjects?: readonly string[];
  readonly grades?: readonly string[];
  readonly concepts?: readonly string[];
  readonly reviewedStatus?: 'draft' | 'verified';
  /** Raw override, used to write deliberately invalid manifests. */
  readonly manifestOverride?: Record<string, unknown>;
  readonly omitLocales?: boolean;
  /** Written verbatim as `state-schema.json`; used to exercise saved-parameter validation. */
  readonly stateSchema?: Record<string, unknown>;
  /**
   * Written verbatim as `curriculum.json`; `null` writes nothing (an experiment without
   * curriculum placements). Used to exercise placement/preset validation.
   *
   * A `catalogs` array inside this object is a **fixture shorthand only**: the shipped
   * layout keeps catalogs in `curricula/<subject>/<file>.json` (ADR-005), so the helper
   * files them there and writes `curriculum.json` with the placements alone. New cases
   * that are about catalog files should declare `catalogs` on the entry instead.
   */
  readonly curriculum?: Record<string, unknown> | null;
  /**
   * Writes `curriculum` exactly as given, without the catalog-splitting shorthand above.
   * Needed to prove that a file which still carries `catalogs` is refused rather than
   * silently migrated.
   */
  readonly rawCurriculum?: boolean;
  /**
   * Shared subject-level catalogs (ADR-005). Written to
   * `<root>/curricula/<subject>/<slug>.json`; the tool's own `curriculum.json` then only
   * carries placements that reference them.
   */
  readonly catalogs?: readonly Record<string, unknown>[];
}

/** One `curricula/<subject>/<file>.json` document, as shipped. */
export interface CurriculumCatalogFile {
  /** Directory name under `curricula/`; also the file's declared subject. */
  readonly subject: string;
  /** File name without `.json`. */
  readonly file: string;
  readonly catalogs: readonly Record<string, unknown>[];
  readonly note?: string;
  /** Defaults to 1; used to exercise unknown schema versions. */
  readonly schemaVersion?: number;
  /**
   * Written as the file's `subject` instead of `subject` above, to exercise a file whose
   * declared subject disagrees with its directory.
   */
  readonly declaredSubject?: string;
}

/**
 * Writes shared catalog documents under `<root>/curricula/<subject>/<file>.json`.
 * `loadContentIndex()` looks for that directory next to the content directory, so a
 * fixture root carries both `experiments/` and `curricula/`.
 */
export async function writeCurriculaDir(
  root: string,
  files: readonly CurriculumCatalogFile[],
): Promise<string> {
  const curriculaDir = path.join(root, 'curricula');
  await mkdir(curriculaDir, { recursive: true });
  for (const file of files) {
    const subjectDir = path.join(curriculaDir, file.subject);
    await mkdir(subjectDir, { recursive: true });
    const document = {
      schemaVersion: file.schemaVersion ?? 1,
      subject: file.declaredSubject ?? file.subject,
      ...(file.note === undefined ? {} : { note: file.note }),
      catalogs: [...file.catalogs],
    };
    await writeFile(
      path.join(subjectDir, `${file.file}.json`),
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8',
    );
  }
  return curriculaDir;
}

const DEFAULTS = {
  moduleVersion: '0.1.0',
  contentVersion: '1.0.0',
  subjects: ['math'],
  grades: ['middle'],
  concepts: ['linear-function'],
  reviewedStatus: 'draft',
} as const;

export async function writeContentDir(
  root: string,
  entries: readonly ContentFixtureEntry[],
): Promise<string> {
  const contentDir = path.join(root, 'experiments');
  await mkdir(contentDir, { recursive: true });

  const sharedCatalogs: CurriculumCatalogFile[] = [];

  for (const entry of entries) {
    const folder = path.join(contentDir, entry.slug);
    await mkdir(folder, { recursive: true });
    const manifest = {
      id: entry.id,
      slug: entry.slug,
      moduleVersion: entry.moduleVersion ?? DEFAULTS.moduleVersion,
      contentVersion: entry.contentVersion ?? DEFAULTS.contentVersion,
      sdkVersionRange: '^1.0.0',
      titleKey: 'title',
      descriptionKey: 'description',
      subjects: entry.subjects ?? DEFAULTS.subjects,
      grades: entry.grades ?? DEFAULTS.grades,
      concepts: entry.concepts ?? DEFAULTS.concepts,
      languages: ['zh-CN', 'en'],
      offlineSupport: true,
      reviewedStatus: entry.reviewedStatus ?? DEFAULTS.reviewedStatus,
      ...(entry.manifestOverride ?? {}),
    };
    await writeFile(
      path.join(folder, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    if (entry.stateSchema !== undefined) {
      await writeFile(
        path.join(folder, 'state-schema.json'),
        JSON.stringify(entry.stateSchema, null, 2),
        'utf8',
      );
    }
    if (entry.catalogs !== undefined) {
      sharedCatalogs.push({
        subject: entry.subjects?.[0] ?? 'math',
        file: entry.slug,
        catalogs: entry.catalogs,
      });
    }
    if (entry.curriculum !== undefined && entry.curriculum !== null) {
      const raw = entry.curriculum;
      const inline = entry.rawCurriculum === true ? null : Array.isArray(raw.catalogs) ? raw.catalogs : null;
      if (inline !== null) {
        // Fixture shorthand (see ContentFixtureEntry.curriculum): file the catalogs where
        // the shipped layout keeps them and leave `curriculum.json` with placements only.
        const first = inline.find(
          (candidate): candidate is Record<string, unknown> =>
            typeof candidate === 'object' &&
            candidate !== null &&
            typeof (candidate as Record<string, unknown>).subject === 'string',
        );
        sharedCatalogs.push({
          subject: typeof first?.subject === 'string' ? first.subject : 'math',
          file: entry.slug,
          catalogs: inline,
        });
        const { catalogs: _catalogs, ...withoutCatalogs } = raw;
        await writeFile(
          path.join(folder, 'curriculum.json'),
          `${JSON.stringify({ ...withoutCatalogs, schemaVersion: 3 }, null, 2)}\n`,
          'utf8',
        );
      } else {
        await writeFile(
          path.join(folder, 'curriculum.json'),
          `${JSON.stringify(raw, null, 2)}\n`,
          'utf8',
        );
      }
    }
    if (entry.omitLocales === true) {
      continue;
    }
    await mkdir(path.join(folder, 'locales'), { recursive: true });
    await writeFile(
      path.join(folder, 'locales', 'en.json'),
      `${JSON.stringify(
        {
          title: entry.titleEn,
          description: entry.descriptionEn ?? `${entry.titleEn} description`,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(
      path.join(folder, 'locales', 'zh-CN.json'),
      `${JSON.stringify(
        {
          title: entry.titleZh,
          description: entry.descriptionZh ?? `${entry.titleZh}说明`,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  if (sharedCatalogs.length > 0) {
    await writeCurriculaDir(root, sharedCatalogs);
  }

  return contentDir;
}

/** The three-experiment fixture used by the catalog tests. */
export const CATALOG_FIXTURE: readonly ContentFixtureEntry[] = [
  {
    id: 'math.functions',
    slug: 'math-functions',
    titleEn: 'Linear and quadratic functions',
    titleZh: '一次函数与二次函数',
    subjects: ['math'],
    grades: ['middle', 'high'],
    concepts: ['linear-function', 'quadratic-function'],
    contentVersion: '1.0.0',
  },
  {
    id: 'physics.freefall',
    slug: 'physics-freefall',
    titleEn: 'Free fall',
    titleZh: '自由落体',
    subjects: ['physics'],
    grades: ['high'],
    concepts: ['acceleration'],
    contentVersion: '2.3.1',
    reviewedStatus: 'verified',
  },
  {
    id: 'math.geometry',
    slug: 'math-geometry',
    titleEn: 'Circle and chord',
    titleZh: '圆与弦',
    subjects: ['math'],
    grades: ['middle'],
    concepts: ['circle'],
    contentVersion: '0.4.0',
  },
];
