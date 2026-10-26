/**
 * Manifest discovery. Adding an experiment means adding `experiments/<folder>/` with a
 * manifest.json, view.tsx and locales/*.json — no host file changes.
 *
 * The glob is transformed at build time by Vite, so a broken manifest fails validation
 * in tests/CI instead of silently disappearing from the catalog.
 */
import type { ComponentType } from 'react';
import {
  SDK_VERSION,
  caretRangeMajor,
  isSdkCompatible,
  type ExperimentManifest,
  type ExperimentProps,
  type Locale,
} from './contract';
import { parseStateSchema, type ExperimentStateSchema } from './state-schema';

export type ExperimentDictionary = Record<string, string>;

export interface ManifestEntry {
  folder: string;
  manifest: ExperimentManifest;
}

export interface RegistryEntry extends ManifestEntry {
  compatible: boolean;
  issues: string[];
  locales: Partial<Record<Locale, ExperimentDictionary>>;
  /**
   * Declared parameter-snapshot schema (design §7.5), or `null` when this experiment does
   * not offer saved settings. Parsed from the same file the server validates.
   */
  stateSchema: ExperimentStateSchema | null;
  loadView: () => Promise<{ default: ComponentType<ExperimentProps> }>;
}

type ViewLoader = () => Promise<{ default: ComponentType<ExperimentProps> }>;
type LocaleModule = { default: ExperimentDictionary };

const manifestModules = import.meta.glob<{ default: ExperimentManifest }>(
  '../../../../experiments/*/manifest.json',
  { eager: true },
);
const viewModules = import.meta.glob<{ default: ComponentType<ExperimentProps> }>(
  '../../../../experiments/*/view.tsx',
);
const localeModules = import.meta.glob<LocaleModule>(
  '../../../../experiments/*/locales/*.json',
  { eager: true },
);
const stateSchemaModules = import.meta.glob<{ default: unknown }>(
  '../../../../experiments/*/state-schema.json',
  { eager: true },
);

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EXPERIMENT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function folderFromPath(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 2] ?? path;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim() !== '')
  );
}

/**
 * Structural validation shared by tests, CI and the dev registry. Messages are meant to
 * be actionable for a contributor adding a new experiment folder.
 */
export function validateManifests(entries: ManifestEntry[], hostVersion = SDK_VERSION): string[] {
  const issues: string[] = [];
  const seenIds = new Map<string, string>();
  const seenSlugs = new Map<string, string>();

  for (const { folder, manifest } of entries) {
    const prefix = `[${folder}]`;
    if (!manifest || typeof manifest !== 'object') {
      issues.push(`${prefix} manifest is not an object`);
      continue;
    }
    if (!EXPERIMENT_ID.test(manifest.id ?? '')) {
      issues.push(`${prefix} id "${manifest.id}" must look like "math.functions"`);
    }
    if (!SLUG.test(manifest.slug ?? '')) {
      issues.push(`${prefix} slug "${manifest.slug}" must be kebab-case (a-z, 0-9, -)`);
    }
    if (!SEMVER.test(manifest.moduleVersion ?? '')) {
      issues.push(`${prefix} moduleVersion "${manifest.moduleVersion}" is not semver`);
    }
    // The server content index requires contentVersion; the browser only carries it, so a
    // malformed value is still reported here rather than reaching a page silently.
    if (manifest.contentVersion !== undefined && !SEMVER.test(manifest.contentVersion)) {
      issues.push(`${prefix} contentVersion "${manifest.contentVersion}" is not semver`);
    }
    if (caretRangeMajor(manifest.sdkVersionRange ?? '') === null) {
      issues.push(`${prefix} sdkVersionRange "${manifest.sdkVersionRange}" must be a caret range like "^1.0.0"`);
    } else if (!isSdkCompatible(manifest.sdkVersionRange, hostVersion)) {
      issues.push(
        `${prefix} incompatible SDK range ${manifest.sdkVersionRange} with host SDK ${hostVersion}`,
      );
    }
    if (typeof manifest.titleKey !== 'string' || manifest.titleKey.trim() === '') {
      issues.push(`${prefix} titleKey must be a non-empty string`);
    }
    if (typeof manifest.descriptionKey !== 'string' || manifest.descriptionKey.trim() === '') {
      issues.push(`${prefix} descriptionKey must be a non-empty string`);
    }
    if (!isNonEmptyStringArray(manifest.subjects)) issues.push(`${prefix} subjects must be a non-empty string array`);
    if (!isNonEmptyStringArray(manifest.grades)) issues.push(`${prefix} grades must be a non-empty string array`);
    if (!isNonEmptyStringArray(manifest.concepts)) issues.push(`${prefix} concepts must be a non-empty string array`);
    if (!Array.isArray(manifest.languages) || !manifest.languages.includes('zh-CN') || !manifest.languages.includes('en')) {
      issues.push(`${prefix} languages must include "zh-CN" and "en"`);
    }
    if (typeof manifest.offlineSupport !== 'boolean') {
      issues.push(`${prefix} offlineSupport must be a boolean`);
    }
    if (manifest.reviewedStatus !== 'draft' && manifest.reviewedStatus !== 'verified') {
      issues.push(`${prefix} reviewedStatus must be "draft" or "verified"`);
    }

    const previousId = seenIds.get(manifest.id);
    if (previousId) {
      issues.push(`${prefix} duplicate id "${manifest.id}" also used by [${previousId}]`);
    } else if (manifest.id) {
      seenIds.set(manifest.id, folder);
    }
    const previousSlug = seenSlugs.get(manifest.slug);
    if (previousSlug) {
      issues.push(`${prefix} duplicate slug "${manifest.slug}" also used by [${previousSlug}]`);
    } else if (manifest.slug) {
      seenSlugs.set(manifest.slug, folder);
    }
  }

  return issues;
}

function collectLocales(): Map<string, Partial<Record<Locale, ExperimentDictionary>>> {
  const byFolder = new Map<string, Partial<Record<Locale, ExperimentDictionary>>>();
  for (const [path, module] of Object.entries(localeModules)) {
    const match = /experiments\/([^/]+)\/locales\/([^/]+)\.json$/.exec(path);
    if (!match) continue;
    const [, folder, locale] = match;
    if (!['en', 'zh-CN'].includes(locale)) continue;
    const bucket = byFolder.get(folder) ?? {};
    bucket[locale as Locale] = module.default;
    byFolder.set(folder, bucket);
  }
  return byFolder;
}

function buildRegistry(hostVersion: string): RegistryEntry[] {
  const folders = new Set<string>();
  for (const path of Object.keys(manifestModules)) folders.add(folderFromPath(path));
  for (const path of Object.keys(viewModules)) folders.add(folderFromPath(path));

  const locales = collectLocales();
  const entries: ManifestEntry[] = [];
  const loaders = new Map<string, ViewLoader>();

  for (const folder of folders) {
    const manifestPath = `../../../../experiments/${folder}/manifest.json`;
    const manifestModule = manifestModules[manifestPath];
    if (!manifestModule) continue;
    entries.push({ folder, manifest: manifestModule.default });
    const loader = viewModules[`../../../../experiments/${folder}/view.tsx`];
    if (loader) loaders.set(folder, loader);
  }

  const issues = validateManifests(entries, hostVersion);
  return entries
    .map(({ folder, manifest }) => {
      const ownIssues = issues.filter((issue) => issue.startsWith(`[${folder}]`));
      if (!loaders.has(folder)) ownIssues.push(`[${folder}] view.tsx not found`);

      // Optional: an experiment without saved settings simply has no state-schema.json.
      let stateSchema: ExperimentStateSchema | null = null;
      const schemaModule = stateSchemaModules[`../../../../experiments/${folder}/state-schema.json`];
      if (schemaModule !== undefined) {
        const parsed = parseStateSchema(schemaModule.default);
        if (parsed.ok) {
          stateSchema = parsed.schema;
        } else {
          for (const issue of parsed.issues) {
            ownIssues.push(`[${folder}] state-schema.json: ${issue}`);
          }
        }
      }

      return {
        folder,
        manifest,
        compatible: isSdkCompatible(manifest.sdkVersionRange ?? '', hostVersion),
        issues: ownIssues,
        locales: locales.get(folder) ?? {},
        stateSchema,
        loadView: loaders.get(folder) ?? (() => Promise.reject(new Error(`[${folder}] view.tsx not found`))),
      };
    })
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export const experiments: RegistryEntry[] = buildRegistry(SDK_VERSION);

export function getExperimentBySlug(slug: string): RegistryEntry | undefined {
  return experiments.find((entry) => entry.manifest.slug === slug);
}

export function getExperimentById(id: string): RegistryEntry | undefined {
  return experiments.find((entry) => entry.manifest.id === id);
}

/** Localized title/description for catalog cards, with a visible fallback. */
export function textFor(
  entry: RegistryEntry,
  locale: Locale,
  key: 'title' | 'description',
): string {
  const dictionary = entry.locales[locale] ?? entry.locales.en;
  const value = dictionary?.[key];
  return value && value.trim() !== '' ? value : `${entry.manifest.slug}:${key}`;
}
