/**
 * Client-side parameter-snapshot rules (design §7.5/§10, D13, R-17/R-18).
 *
 * Dependency-free on purpose: the experiment host, the experiment module and the tests all
 * import it, and a new experiment gets saved settings for free by shipping the same
 * `state-schema.json` the server validates against.
 *
 * The server stays authoritative. This module exists so the browser can answer "may I apply
 * this snapshot?" and "what exactly do I send when the user clicks save?" without a round
 * trip, using the same rules — `tests/state-schema.test.ts` runs both implementations on one
 * case table so they cannot drift.
 */

export const MAX_STATE_PAYLOAD_BYTES = 4096;

export interface NumberFieldSpec {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

export interface EnumFieldSpec {
  readonly kind: 'enum';
  readonly values: readonly string[];
  readonly default: string;
}

export type StateFieldSpec = NumberFieldSpec | EnumFieldSpec;

export interface ExperimentStateSchema {
  readonly version: number;
  readonly fields: Readonly<Record<string, StateFieldSpec>>;
}

export type StateValue = number | string;
export type StateValues = Record<string, StateValue>;

export type SchemaParse =
  | { readonly ok: true; readonly schema: ExperimentStateSchema }
  | { readonly ok: false; readonly issues: readonly string[] };

const FIELD_KEYS: Record<StateFieldSpec['kind'], readonly string[]> = {
  number: ['kind', 'min', 'max', 'step', 'default'],
  enum: ['kind', 'values', 'default'],
};

const STEP_TOLERANCE = 1e-6;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStateSchema(raw: unknown): SchemaParse {
  if (!isPlainObject(raw)) {
    return { ok: false, issues: ['state schema must be a JSON object'] };
  }
  const issues: string[] = [];
  const extra = Object.keys(raw).filter((key) => key !== 'schemaVersion' && key !== 'fields');
  if (extra.length > 0) {
    issues.push(`unknown top-level keys: ${extra.join(', ')}`);
  }
  const version = raw.schemaVersion;
  if (!isFiniteNumber(version) || !Number.isInteger(version) || version < 1) {
    issues.push('schemaVersion must be an integer >= 1');
  }
  const fieldsRaw = raw.fields;
  if (!isPlainObject(fieldsRaw)) {
    issues.push('fields must be an object');
  }

  const fields: Record<string, StateFieldSpec> = {};
  if (isPlainObject(fieldsRaw)) {
    const names = Object.keys(fieldsRaw);
    if (names.length === 0) issues.push('fields must declare at least one parameter');
    for (const name of names) {
      const spec = fieldsRaw[name];
      if (!isPlainObject(spec)) {
        issues.push(`field "${name}" must be an object`);
        continue;
      }
      const kind = spec.kind;
      if (kind !== 'number' && kind !== 'enum') {
        issues.push(`field "${name}" has unknown kind "${String(kind)}"`);
        continue;
      }
      const unexpected = Object.keys(spec).filter((key) => !FIELD_KEYS[kind].includes(key));
      if (unexpected.length > 0) {
        issues.push(`field "${name}" has unexpected keys: ${unexpected.join(', ')}`);
        continue;
      }
      if (kind === 'number') {
        const { min, max, step, default: fallback } = spec;
        if (!isFiniteNumber(min) || !isFiniteNumber(max) || min > max) {
          issues.push(`field "${name}" needs a finite min <= max`);
          continue;
        }
        if (!isFiniteNumber(step) || step <= 0) {
          issues.push(`field "${name}" needs a positive step`);
          continue;
        }
        if (!isFiniteNumber(fallback) || fallback < min || fallback > max) {
          issues.push(`field "${name}" needs a default inside its range`);
          continue;
        }
        fields[name] = { kind: 'number', min, max, step, default: fallback };
      } else {
        const values = spec.values;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          !values.every((value): value is string => typeof value === 'string' && value !== '') ||
          new Set(values).size !== values.length
        ) {
          issues.push(`field "${name}" needs a non-empty list of unique string values`);
          continue;
        }
        const fallback = spec.default;
        if (typeof fallback !== 'string' || !values.includes(fallback)) {
          issues.push(`field "${name}" needs a default that is one of its values`);
          continue;
        }
        fields[name] = { kind: 'enum', values: [...values], default: fallback };
      }
    }
  }

  if (issues.length > 0 || !isFiniteNumber(version)) {
    return { ok: false, issues };
  }
  return { ok: true, schema: { version, fields } };
}

export function defaultStateValues(schema: ExperimentStateSchema): StateValues {
  const values: StateValues = {};
  for (const key of Object.keys(schema.fields).sort()) {
    const field = schema.fields[key];
    if (field !== undefined) values[key] = field.default;
  }
  return values;
}

function checkNumber(field: NumberFieldSpec, value: unknown): boolean {
  if (!isFiniteNumber(value)) return false;
  if (value < field.min || value > field.max) return false;
  const steps = (value - field.min) / field.step;
  return Math.abs(steps - Math.round(steps)) <= STEP_TOLERANCE;
}

export function statePayloadBytes(payload: string): number {
  return new TextEncoder().encode(payload).length;
}

/**
 * Strict validation of a complete parameter set (both implementations agree on this).
 * On failure the caller gets the defaults, because every caller either falls back to them
 * (restore) or refuses to save.
 */
export function normalizeStateValues(
  schema: ExperimentStateSchema,
  input: unknown,
): { readonly ok: boolean; readonly values: StateValues } {
  const declared = Object.keys(schema.fields);
  if (!isPlainObject(input)) {
    return { ok: false, values: defaultStateValues(schema) };
  }
  const given = Object.keys(input);
  if (given.some((key) => !declared.includes(key)) || declared.some((key) => !given.includes(key))) {
    return { ok: false, values: defaultStateValues(schema) };
  }

  const values: StateValues = {};
  for (const key of declared) {
    const field = schema.fields[key];
    const value = input[key];
    if (field === undefined) continue;
    if (field.kind === 'number') {
      if (!checkNumber(field, value)) {
        return { ok: false, values: defaultStateValues(schema) };
      }
      values[key] = value as number;
    } else {
      if (typeof value !== 'string' || !field.values.includes(value)) {
        return { ok: false, values: defaultStateValues(schema) };
      }
      values[key] = value;
    }
  }

  const ordered: StateValues = {};
  for (const key of [...declared].sort()) {
    const value = values[key];
    if (value !== undefined) ordered[key] = value;
  }
  if (statePayloadBytes(JSON.stringify(ordered)) > MAX_STATE_PAYLOAD_BYTES) {
    return { ok: false, values: defaultStateValues(schema) };
  }
  return { ok: true, values: ordered };
}

/**
 * The exact bytes to send on save: declared keys only (an experiment module that exposes an
 * extra field cannot smuggle it through), sorted, validated. `null` means "do not send".
 */
export function canonicalStatePayload(
  schema: ExperimentStateSchema,
  values: unknown,
): string | null {
  if (!isPlainObject(values)) return null;
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(schema.fields)) {
    if (key in values) picked[key] = values[key];
  }
  const normalized = normalizeStateValues(schema, picked);
  if (!normalized.ok) return null;
  return JSON.stringify(normalized.values);
}
