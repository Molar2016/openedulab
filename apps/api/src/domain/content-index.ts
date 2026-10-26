import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
  /** The validated manifest as shipped, for the experiment detail endpoint. */
  readonly manifest: Readonly<Record<string, unknown>>;
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
  find(id: string): ContentExperiment | undefined;
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
 * Loads and validates every manifest under `contentDir`. Throws ContentIndexError with
 * the full list of problems rather than returning a partial catalog.
 */
export function loadContentIndex(
  contentDir: string,
  options: { readonly hostSdkVersion?: string } = {},
): ContentIndex {
  const hostVersion = options.hostSdkVersion ?? HOST_SDK_VERSION;
  const hostMajor = Number(hostVersion.split('.')[0]);
  const issues: string[] = [];
  const experiments: ContentExperiment[] = [];
  const seenIds = new Map<string, string>();
  const seenSlugs = new Map<string, string>();

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
      manifest: Object.freeze({ ...manifest }),
    });
  }

  if (issues.length > 0) {
    throw new ContentIndexError(issues);
  }

  experiments.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const frozen = Object.freeze(experiments);

  return {
    experiments: frozen,
    find(id) {
      return frozen.find((entry) => entry.id === id);
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
