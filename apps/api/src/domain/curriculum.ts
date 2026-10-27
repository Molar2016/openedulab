import { validateStateValues, type StateSchema, type StateValue } from './state-validator.js';

/**
 * Declared locally on purpose: `content-index.ts` imports this module, so importing its
 * locale list back would create a cycle for no benefit.
 */
export const PLACEMENT_LOCALES = ['zh-CN', 'en'] as const;
export type PlacementLocale = (typeof PLACEMENT_LOCALES)[number];

/**
 * Curriculum placements (ADR-003).
 *
 * A placement is a *directory entry*, not a second copy of an experiment: it names the
 * stable tool id it points at, its own stable id + version, the edition/book/chapter
 * position it occupies, and one preset parameter set. Placements are content, so they are
 * validated at startup together with the manifests — and a preset that the tool's own
 * `state-schema.json` would reject is a startup error, never a page that silently shows
 * different numbers than the chapter promised.
 *
 * This module never touches the filesystem or the database: it turns one parsed JSON value
 * into validated data, so both the index and the tests use the same rules.
 */

export const PLACEMENT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
export const PLACEMENT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CURRICULUM_SCHEMA_VERSION = 1;

export type PlacementStatus = 'illustrative' | 'verified';

export interface PlacementNode {
  readonly id: string;
  readonly labels: Readonly<Record<PlacementLocale, string>>;
}

export interface CurriculumPlacement {
  readonly placementId: string;
  readonly slug: string;
  /** The stable tool id this placement reuses. */
  readonly experimentId: string;
  readonly version: number;
  /** `illustrative` means "pilot example, not a verified textbook chapter". */
  readonly status: PlacementStatus;
  readonly order: number;
  readonly edition: PlacementNode;
  readonly book: PlacementNode;
  readonly chapter: PlacementNode;
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
}

/** Used by the content index so uniqueness spans every experiment folder. */
export function createPlacementUniqueness(): SharedUniqueness {
  return { placementIds: new Map(), slugs: new Map() };
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

function readNode(raw: unknown, label: string, issues: string[]): PlacementNode | null {
  if (!isPlainObject(raw)) {
    issues.push(`${label} must be an object with "id" and "labels"`);
    return null;
  }
  const unexpected = Object.keys(raw).filter((key) => key !== 'id' && key !== 'labels');
  if (unexpected.length > 0) {
    issues.push(`${label} has unexpected keys: ${unexpected.join(', ')}`);
  }
  if (typeof raw.id !== 'string' || !PLACEMENT_SLUG.test(raw.id)) {
    issues.push(`${label}.id must be kebab-case`);
  }
  const labels = readLocalized(raw.labels, `${label}.labels`, issues);
  if (typeof raw.id !== 'string' || labels === null) return null;
  return { id: raw.id, labels };
}

export interface PlacementParseOptions {
  readonly experimentId: string;
  readonly stateSchema: StateSchema | null;
  /** Folders are reported in messages so a contributor can find the file. */
  readonly folder: string;
  /** Shared across folders: two chapters must not claim the same URL. */
  readonly uniqueness: SharedUniqueness;
}

/**
 * Parses one experiment's `curriculum.json`. A missing placement list is legitimate (a tool
 * may simply not be in the curriculum yet); anything present but wrong is reported.
 */
export function parseCurriculum(
  raw: unknown,
  options: PlacementParseOptions,
): PlacementParseResult {
  const { experimentId, stateSchema, folder, uniqueness } = options;
  const issues: string[] = [];
  const placements: CurriculumPlacement[] = [];
  const prefix = `[${folder}] curriculum.json`;

  if (!isPlainObject(raw)) {
    return { placements, issues: [`${prefix} must be a JSON object`] };
  }
  const unexpected = Object.keys(raw).filter(
    (key) => key !== 'schemaVersion' && key !== 'placements' && key !== 'note',
  );
  if (unexpected.length > 0) {
    issues.push(`${prefix} has unknown top-level keys: ${unexpected.join(', ')}`);
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

  const seenOrders = new Map<number, string>();

  raw.placements.forEach((candidate, index) => {
    const where = `${prefix} placements[${String(index)}]`;
    if (!isPlainObject(candidate)) {
      issues.push(`${where} must be an object`);
      return;
    }
    const entryIssues: string[] = [];
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
      entryIssues.push('order must be an integer >= 1');
    }

    const edition = readNode(candidate.edition, `${where}.edition`, entryIssues);
    const book = readNode(candidate.book, `${where}.book`, entryIssues);
    const chapter = readNode(candidate.chapter, `${where}.chapter`, entryIssues);
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

    const order = isPositiveInteger(candidate.order) ? candidate.order : null;
    if (order !== null) {
      const owner = seenOrders.get(order);
      if (owner !== undefined) {
        entryIssues.push(`order ${String(order)} is already used by "${owner}"`);
      } else {
        seenOrders.set(order, placementId);
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
      order: order as number,
      edition: edition as PlacementNode,
      book: book as PlacementNode,
      chapter: chapter as PlacementNode,
      title: title as Record<PlacementLocale, string>,
      summary: summary as Record<PlacementLocale, string>,
      preset: preset as Record<string, StateValue>,
      stateSchemaVersion: stateSchema === null ? 0 : stateSchema.version,
    });
  });

  placements.sort((left, right) =>
    left.order === right.order
      ? left.placementId.localeCompare(right.placementId)
      : left.order - right.order,
  );
  return { placements, issues };
}
