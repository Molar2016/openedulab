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

async function validateExperiment(folder, hostMajor, seenIds, seenSlugs) {
  const dir = join(EXPERIMENTS_DIR, folder);
  const manifestPath = join(dir, 'manifest.json');
  const manifest = await readJson(manifestPath, `${folder}/manifest.json`);
  if (!manifest) return null;

  if (!ID.test(manifest.id ?? '')) fail(`${folder}: id "${manifest.id}" must look like "math.functions"`);
  if (!SLUG.test(manifest.slug ?? '')) fail(`${folder}: slug "${manifest.slug}" must be kebab-case`);
  if (!SEMVER.test(manifest.moduleVersion ?? '')) fail(`${folder}: moduleVersion "${manifest.moduleVersion}" must be semver`);

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
  return { id: manifest.id, slug: manifest.slug, localeFiles };
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
  const experiments = [];
  for (const folder of folders) {
    const result = await validateExperiment(folder, hostMajor, seenIds, seenSlugs);
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
