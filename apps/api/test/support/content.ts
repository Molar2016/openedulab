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
   */
  readonly curriculum?: Record<string, unknown> | null;
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
    if (entry.curriculum !== undefined && entry.curriculum !== null) {
      await writeFile(
        path.join(folder, 'curriculum.json'),
        `${JSON.stringify(entry.curriculum, null, 2)}\n`,
        'utf8',
      );
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
