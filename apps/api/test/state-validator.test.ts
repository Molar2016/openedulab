import { describe, expect, it } from 'vitest';

import {
  MAX_STATE_PAYLOAD_BYTES,
  parseStateSchema,
  validateStateValues,
  type StateSchema,
} from '../src/domain/state-validator.js';

/**
 * Parameter snapshot validation (design §7.5, R-17/R-18).
 *
 * The server is the authority: a client may send anything, and only the values the
 * experiment declared in `state-schema.json` may ever reach storage. These tests pin the
 * three rules that matter — strict whitelist, real bounds, bounded payload — plus the
 * canonical serialisation, because the stored bytes are what gets compared later.
 */

const SCHEMA: StateSchema = {
  version: 1,
  fields: {
    mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
    a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
    b: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
  },
};

function parse(raw: unknown) {
  return parseStateSchema(raw);
}

describe('parseStateSchema', () => {
  it('accepts a well-formed schema and preserves its declared defaults', () => {
    const result = parse({
      schemaVersion: 1,
      fields: {
        mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
        a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.version).toBe(1);
    expect(result.schema.fields.a).toEqual({ kind: 'number', min: -10, max: 10, step: 0.1, default: 1 });
    expect(result.schema.fields.mode).toEqual({
      kind: 'enum',
      values: ['linear', 'quadratic'],
      default: 'quadratic',
    });
  });

  it.each([
    ['not an object', 42],
    ['an array', []],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    const result = parse(raw);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['schemaVersion 0', { schemaVersion: 0, fields: { a: { kind: 'number', min: 0, max: 1, step: 0.1, default: 0 } } }],
    ['a non-integer schemaVersion', { schemaVersion: 1.5, fields: { a: { kind: 'number', min: 0, max: 1, step: 0.1, default: 0 } } }],
    ['a string schemaVersion', { schemaVersion: '1', fields: { a: { kind: 'number', min: 0, max: 1, step: 0.1, default: 0 } } }],
    ['no fields', { schemaVersion: 1, fields: {} }],
    ['fields as an array', { schemaVersion: 1, fields: [] }],
  ])('rejects %s', (_label, raw) => {
    expect(parse(raw).ok).toBe(false);
  });

  it('rejects an unknown field kind', () => {
    const result = parse({
      schemaVersion: 1,
      fields: { a: { kind: 'text', default: 'x' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('kind');
  });

  it('rejects a number field whose default is outside its own bounds', () => {
    const result = parse({
      schemaVersion: 1,
      fields: { a: { kind: 'number', min: 0, max: 1, step: 0.1, default: 5 } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an enum field whose default is not one of its values', () => {
    const result = parse({
      schemaVersion: 1,
      fields: { mode: { kind: 'enum', values: ['linear'], default: 'cubic' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive step and an inverted range', () => {
    expect(
      parse({ schemaVersion: 1, fields: { a: { kind: 'number', min: 0, max: 1, step: 0, default: 0 } } }).ok,
    ).toBe(false);
    expect(
      parse({ schemaVersion: 1, fields: { a: { kind: 'number', min: 2, max: 1, step: 0.1, default: 2 } } }).ok,
    ).toBe(false);
  });

  it('rejects extra keys inside a field declaration', () => {
    const result = parse({
      schemaVersion: 1,
      fields: { a: { kind: 'number', min: 0, max: 1, step: 0.1, default: 0, unit: 'm' } },
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateStateValues', () => {
  it('accepts exactly the declared keys and returns a canonical payload', () => {
    const result = validateStateValues(SCHEMA, { b: -2, mode: 'linear', a: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({ mode: 'linear', a: 3, b: -2 });
    // Keys are sorted so the stored bytes do not depend on the client's key order.
    expect(result.payload).toBe('{"a":3,"b":-2,"mode":"linear"}');
  });

  it('rejects an unknown key instead of silently dropping it', () => {
    const result = validateStateValues(SCHEMA, { mode: 'linear', a: 1, b: 0, d: 7 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_key');
    expect(result.fields).toEqual(['d']);
  });

  it('rejects a missing key', () => {
    const result = validateStateValues(SCHEMA, { mode: 'linear', a: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_key');
    expect(result.fields).toEqual(['b']);
  });

  it.each([
    ['not an object', 'a'],
    ['an array', [1, 2, 3]],
    ['null', null],
  ])('rejects %s as the values payload', (_label, values) => {
    const result = validateStateValues(SCHEMA, values);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_an_object');
  });

  it('rejects a value outside its declared range', () => {
    const result = validateStateValues(SCHEMA, { mode: 'linear', a: 10.1, b: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('out_of_range');
    expect(result.fields).toEqual(['a']);
  });

  it('rejects a value that is not a multiple of its step', () => {
    const result = validateStateValues(SCHEMA, { mode: 'linear', a: 0.15, b: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('off_step');
  });

  it('tolerates floating-point noise from a slider (0.30000000000000004 on a 0.1 step)', () => {
    const result = validateStateValues(SCHEMA, { mode: 'linear', a: 0.30000000000000004, b: -0.3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.a).toBe(0.30000000000000004);
  });

  it('rejects a number sent as a string, a boolean or an object', () => {
    for (const value of ['1', true, { v: 1 }]) {
      const result = validateStateValues(SCHEMA, { mode: 'linear', a: value, b: 0 });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('invalid_number');
    }
  });

  it('rejects NaN and Infinity', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateStateValues(SCHEMA, { mode: 'linear', a: value, b: 0 });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an enum value that is not in the whitelist', () => {
    const result = validateStateValues(SCHEMA, { mode: 'cubic', a: 1, b: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_enum');
    expect(result.fields).toEqual(['mode']);
  });

  it('rejects a payload above the byte budget', () => {
    const fields: Record<string, StateSchema['fields'][string]> = {};
    for (let index = 0; index < 400; index += 1) {
      fields[`field${String(index)}`] = { kind: 'number', min: -10, max: 10, step: 1, default: -10 };
    }
    const big: StateSchema = { version: 1, fields };
    const values: Record<string, number> = {};
    for (const key of Object.keys(fields)) values[key] = -10;

    const result = validateStateValues(big, values);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_large');
    expect(Buffer.byteLength(JSON.stringify(values), 'utf8')).toBeGreaterThan(MAX_STATE_PAYLOAD_BYTES);
  });

  it('accepts a payload exactly at the byte budget boundary and rejects one byte more', () => {
    // Two fields whose serialised length lands on the limit exactly.
    const pad = 'x'.repeat(MAX_STATE_PAYLOAD_BYTES - '{"pad":"","v":0}'.length);
    const atLimit: StateSchema = {
      version: 1,
      fields: {
        pad: { kind: 'enum', values: [pad], default: pad },
        v: { kind: 'number', min: 0, max: 0, step: 1, default: 0 },
      },
    };
    const ok = validateStateValues(atLimit, { pad, v: 0 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(Buffer.byteLength(ok.payload, 'utf8')).toBe(MAX_STATE_PAYLOAD_BYTES);

    const over: StateSchema = {
      version: 1,
      fields: {
        pad: { kind: 'enum', values: [`${pad}x`], default: `${pad}x` },
        v: { kind: 'number', min: 0, max: 0, step: 1, default: 0 },
      },
    };
    const tooBig = validateStateValues(over, { pad: `${pad}x`, v: 0 });
    expect(tooBig.ok).toBe(false);
  });
});
