/**
 * Parameter-snapshot schema and validator (design §5.5/§7.5, D13, R-17/R-18).
 *
 * The browser and the server share this *data* (each experiment ships `state-schema.json`
 * next to its manifest) but not this code: the web build has its own copy in
 * `apps/web/src/experiment/state-schema.ts`, and `tests/state-schema.test.ts` runs both on
 * one case table so they cannot drift.
 *
 * Two rules make the feature safe rather than convenient:
 *   - the server never stores a value the experiment did not declare (strict whitelist,
 *     exact key set, real bounds, real step);
 *   - what is stored is a canonical JSON string, so "same settings" is a byte comparison
 *     and the stored size is bounded before it reaches SQLite.
 */

export const MAX_STATE_PAYLOAD_BYTES = 4096;

export interface NumberField {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

export interface EnumField {
  readonly kind: 'enum';
  readonly values: readonly string[];
  readonly default: string;
}

export type StateField = NumberField | EnumField;

export interface StateSchema {
  readonly version: number;
  readonly fields: Readonly<Record<string, StateField>>;
}

export type StateValue = number | string;
export type StateValues = Readonly<Record<string, StateValue>>;

export type StateRejection =
  | 'not_an_object'
  | 'unknown_key'
  | 'missing_key'
  | 'invalid_number'
  | 'out_of_range'
  | 'off_step'
  | 'invalid_enum'
  | 'too_large';

export type StateValidation =
  | { readonly ok: true; readonly values: Record<string, StateValue>; readonly payload: string }
  | { readonly ok: false; readonly reason: StateRejection; readonly fields: readonly string[] };

export type SchemaParse = { readonly ok: true; readonly schema: StateSchema } | { readonly ok: false; readonly issues: readonly string[] };

const FIELD_KEYS: Record<StateField['kind'], readonly string[]> = {
  number: ['kind', 'min', 'max', 'step', 'default'],
  enum: ['kind', 'values', 'default'],
};

/** Absolute tolerance on `(value - min) / step`; sliders produce 1e-15-scale noise. */
const STEP_TOLERANCE = 1e-6;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates the shipped schema. Anything ambiguous is an error: a schema that
 * half-works would silently accept or reject the user's own settings.
 */
export function parseStateSchema(raw: unknown): SchemaParse {
  if (!isPlainObject(raw)) {
    return { ok: false, issues: ['state schema must be a JSON object'] };
  }
  const issues: string[] = [];
  const extra = Object.keys(raw).filter((key) => key !== 'schemaVersion' && key !== 'fields');
  if (extra.length > 0) {
    issues.push(`state schema has unknown top-level keys: ${extra.join(', ')}`);
  }

  const version = raw.schemaVersion;
  if (!isFiniteNumber(version) || !Number.isInteger(version) || version < 1) {
    issues.push('schemaVersion must be an integer >= 1');
  }

  const fieldsRaw = raw.fields;
  if (!isPlainObject(fieldsRaw)) {
    issues.push('fields must be an object');
  }
  const fields: Record<string, StateField> = {};
  if (isPlainObject(fieldsRaw)) {
    const names = Object.keys(fieldsRaw);
    if (names.length === 0) {
      issues.push('fields must declare at least one parameter');
    }
    for (const name of names) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        issues.push(`field "${name}" must be a simple identifier`);
        continue;
      }
      const spec = fieldsRaw[name];
      if (!isPlainObject(spec)) {
        issues.push(`field "${name}" must be an object`);
        continue;
      }
      const kind = spec.kind;
      if (kind !== 'number' && kind !== 'enum') {
        issues.push(`field "${name}" has unknown kind "${String(kind)}" (expected "number" or "enum")`);
        continue;
      }
      const allowed = FIELD_KEYS[kind];
      const unexpected = Object.keys(spec).filter((key) => !allowed.includes(key));
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
          issues.push(`field "${name}" needs a default inside [${String(min)}, ${String(max)}]`);
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

function checkNumberField(field: NumberField, value: unknown): StateRejection | null {
  if (!isFiniteNumber(value)) return 'invalid_number';
  if (value < field.min || value > field.max) return 'out_of_range';
  const steps = (value - field.min) / field.step;
  if (Math.abs(steps - Math.round(steps)) > STEP_TOLERANCE) return 'off_step';
  return null;
}

/**
 * Validates a client-supplied parameter set against the schema and returns the canonical
 * payload that may be stored. Unknown or missing keys are rejected rather than repaired:
 * storing a silently repaired snapshot would make "restore" a lie.
 */
export function validateStateValues(schema: StateSchema, input: unknown): StateValidation {
  if (!isPlainObject(input)) {
    return { ok: false, reason: 'not_an_object', fields: [] };
  }

  const declared = Object.keys(schema.fields);
  const given = Object.keys(input);
  const unknown = given.filter((key) => !declared.includes(key));
  if (unknown.length > 0) {
    return { ok: false, reason: 'unknown_key', fields: unknown.sort() };
  }
  const missing = declared.filter((key) => !given.includes(key));
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_key', fields: missing.sort() };
  }

  const values: Record<string, StateValue> = {};
  for (const key of declared) {
    const field = schema.fields[key];
    const value = input[key];
    if (field === undefined) continue;

    if (field.kind === 'number') {
      const rejection = checkNumberField(field, value);
      if (rejection !== null) {
        return { ok: false, reason: rejection, fields: [key] };
      }
      values[key] = value as number;
    } else {
      if (typeof value !== 'string' || !field.values.includes(value)) {
        return { ok: false, reason: 'invalid_enum', fields: [key] };
      }
      values[key] = value;
    }
  }

  // Sorted keys: the stored bytes depend on the schema, never on the caller's key order.
  const ordered: Record<string, StateValue> = {};
  for (const key of [...declared].sort()) {
    const value = values[key];
    if (value !== undefined) ordered[key] = value;
  }
  const payload = JSON.stringify(ordered);
  if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_PAYLOAD_BYTES) {
    return { ok: false, reason: 'too_large', fields: [] };
  }

  return { ok: true, values: ordered, payload };
}

/** Defaults declared by the schema — used by tooling and tests, not by the routes. */
export function defaultStateValues(schema: StateSchema): Record<string, StateValue> {
  const values: Record<string, StateValue> = {};
  for (const key of Object.keys(schema.fields).sort()) {
    const field = schema.fields[key];
    if (field !== undefined) values[key] = field.default;
  }
  return values;
}
