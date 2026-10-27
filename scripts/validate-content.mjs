#!/usr/bin/env node
/**
 * Content validation for CI: manifest schema, unique routes, SDK compatibility, locale
 * completeness and UI translation parity. Fails with an actionable list, not a stack.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const EXPERIMENTS_DIR = join(ROOT, 'experiments');
const UI_LOCALES_DIR = join(ROOT, 'apps/web/src/i18n/locales');

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SUPPORTED_LOCALES = ['zh-CN', 'en'];
const PLACEMENT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const PLACEMENT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CURICULUM_SCHEMA_VERSION = 1;

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
    seenPlacementIds,
    seenPlacementSlugs,
  );

  return { id: manifest.id, slug: manifest.slug, localeFiles, placements };
}

/**
 * Curriculum placements (ADR-003). Mirrors the server's startup rules closely enough that a
 * broken preset or a duplicated URL slug fails CI rather than the first page load: the
 * preset is checked against the same `state-schema.json` the server validates.
 */
async function validateCurriculum(folder, dir, manifest, stateSchema, seenIds, seenSlugs) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(dir, 'curriculum.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    fail(`${folder}/curriculum.json: cannot read/parse JSON (${error.message})`);
    return 0;
  }
  const prefix = `${folder}/curriculum.json`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${prefix}: must be a JSON object`);
    return 0;
  }
  for (const key of Object.keys(raw)) {
    if (!['schemaVersion', 'placements', 'note'].includes(key)) {
      fail(`${prefix}: unknown top-level key "${key}"`);
    }
  }
  if (raw.schemaVersion !== CURICULUM_SCHEMA_VERSION) {
    fail(`${prefix}: schemaVersion must be ${CURICULUM_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.placements)) {
    fail(`${prefix}: placements must be an array`);
    return 0;
  }

  let indexed = 0;
  for (const [index, entry] of raw.placements.entries()) {
    const where = `${prefix} placements[${index}]`;
    const issues = [];
    if (entry === null || typeof entry !== 'object') {
      fail(`${where}: must be an object`);
      continue;
    }
    if (!PLACEMENT_ID.test(entry.placementId ?? '')) {
      issues.push(`placementId "${entry.placementId}" must look like "${manifest.id}.<chapter>"`);
    } else if (!entry.placementId.startsWith(`${manifest.id}.`)) {
      issues.push(`placementId "${entry.placementId}" must start with "${manifest.id}."`);
    }
    if (!PLACEMENT_SLUG.test(entry.slug ?? '')) {
      issues.push(`slug "${entry.slug}" must be kebab-case`);
    }
    if (!Number.isInteger(entry.version) || entry.version < 1) {
      issues.push('version must be an integer >= 1');
    }
    if (!Number.isInteger(entry.order) || entry.order < 1) {
      issues.push('order must be an integer >= 1');
    }
    if (!['illustrative', 'verified'].includes(entry.status)) {
      issues.push('status must be "illustrative" or "verified"');
    }
    for (const node of ['edition', 'book', 'chapter']) {
      const value = entry[node];
      if (value === null || typeof value !== 'object') {
        issues.push(`${node} must be an object with id + labels`);
        continue;
      }
      if (!PLACEMENT_SLUG.test(value.id ?? '')) issues.push(`${node}.id must be kebab-case`);
      for (const locale of SUPPORTED_LOCALES) {
        if (typeof value.labels?.[locale] !== 'string' || value.labels[locale].trim() === '') {
          issues.push(`${node}.labels.${locale} must be a non-empty string`);
        }
      }
    }
    for (const text of ['title', 'summary']) {
      for (const locale of SUPPORTED_LOCALES) {
        if (typeof entry[text]?.[locale] !== 'string' || entry[text][locale].trim() === '') {
          issues.push(`${text}.${locale} must be a non-empty string`);
        }
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
          } else if (Math.abs((value - field.min) / field.step - Math.round((value - field.min) / field.step)) > 1e-6) {
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
      indexed += 1;
    }
  }
  return indexed;
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
  const experiments = [];
  for (const folder of folders) {
    const result = await validateExperiment(
      folder,
      hostMajor,
      seenIds,
      seenSlugs,
      seenPlacementIds,
      seenPlacementSlugs,
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
    ` - curriculum placements: ${experiments.map((entry) => `${entry.id}: ${entry.placements}`).join('; ')}`,
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
