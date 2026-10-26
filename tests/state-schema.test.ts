import { describe, expect, it } from 'vitest';

import {
  MAX_STATE_PAYLOAD_BYTES,
  canonicalStatePayload,
  defaultStateValues,
  normalizeStateValues,
  parseStateSchema,
  type ExperimentStateSchema,
} from '../apps/web/src/experiment/state-schema';
import { validateStateValues } from '../apps/api/src/domain/state-validator';

/**
 * Client-side half of the saved-parameter contract (design §7.5/§10, R-17/R-18).
 *
 * The server is authoritative, but the browser still has to answer two questions without a
 * round trip: "may I apply this snapshot?" and "what exactly do I send when the user clicks
 * save?". Doctoring the rules here and there would let a stale bundle write values the
 * current schema no longer allows, so the last block below compares both implementations on
 * the same case table.
 */

const SCHEMA: ExperimentStateSchema = {
  version: 3,
  fields: {
    mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
    a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
    b: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
  },
};

const FULL = { mode: 'linear', a: 2, b: -0.5 } as const;

describe('parseStateSchema (client)', () => {
  it('accepts the shipped math-functions schema shape', () => {
    const result = parseStateSchema({
      schemaVersion: 1,
      fields: {
        mode: { kind: 'enum', values: ['linear', 'quadratic'], default: 'quadratic' },
        a: { kind: 'number', min: -10, max: 10, step: 0.1, default: 1 },
        b: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
        c: { kind: 'number', min: -10, max: 10, step: 0.1, default: 0 },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schema.version).toBe(1);
    expect(Object.keys(result.schema.fields).sort()).toEqual(['a', 'b', 'c', 'mode']);
  });

  it('reports issues instead of throwing on a broken schema', () => {
    const result = parseStateSchema({ schemaVersion: 0, fields: { a: { kind: 'magic' } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('defaultStateValues', () => {
  it('returns exactly the declared defaults', () => {
    expect(defaultStateValues(SCHEMA)).toEqual({ mode: 'quadratic', a: 1, b: 0 });
  });
});

describe('normalizeStateValues', () => {
  it('accepts a complete, in-range snapshot', () => {
    const result = normalizeStateValues(SCHEMA, FULL);

    expect(result.ok).toBe(true);
    expect(result.values).toEqual({ mode: 'linear', a: 2, b: -0.5 });
  });

  it('falls back to the defaults when a field is missing, unknown or out of range', () => {
    const cases = [
      { label: 'missing key', input: { mode: 'linear', a: 2 } },
      { label: 'unknown key', input: { ...FULL, z: 1 } },
      { label: 'out of range', input: { ...FULL, a: 42 } },
      { label: 'wrong type', input: { ...FULL, a: '2' } },
      { label: 'bad enum', input: { ...FULL, mode: 'cubic' } },
      { label: 'off step', input: { ...FULL, a: 0.15 } },
      { label: 'not an object', input: 'nope' },
    ];

    for (const { label, input } of cases) {
      const result = normalizeStateValues(SCHEMA, input);
      expect(result.ok, label).toBe(false);
      expect(result.values, label).toEqual(defaultStateValues(SCHEMA));
    }
  });

  it('tolerates slider floating-point noise', () => {
    const result = normalizeStateValues(SCHEMA, { mode: 'linear', a: 0.30000000000000004, b: 0 });
    expect(result.ok).toBe(true);
  });
});

describe('canonicalStatePayload', () => {
  it('serialises only whitelisted keys, sorted, so the bytes are comparable', () => {
    const payload = canonicalStatePayload(SCHEMA, { b: -0.5, mode: 'linear', a: 2, junk: 'x' });

    expect(payload).toBe('{"a":2,"b":-0.5,"mode":"linear"}');
  });

  it('refuses to serialise values that do not validate', () => {
    expect(canonicalStatePayload(SCHEMA, { mode: 'linear', a: 99, b: 0 })).toBeNull();
  });

  it('exposes the same byte budget as the server', () => {
    expect(MAX_STATE_PAYLOAD_BYTES).toBe(4096);
  });
});

describe('client and server agree on the same case table', () => {
  const serverSchema = {
    version: SCHEMA.version,
    fields: {
      mode: { kind: 'enum' as const, values: ['linear', 'quadratic'] as const, default: 'quadratic' },
      a: { kind: 'number' as const, min: -10, max: 10, step: 0.1, default: 1 },
      b: { kind: 'number' as const, min: -10, max: 10, step: 0.1, default: 0 },
    },
    // The server type keeps enum values mutable; the shape is identical.
  } as unknown as Parameters<typeof validateStateValues>[0];

  const cases: readonly { label: string; input: unknown }[] = [
    { label: 'valid', input: { mode: 'linear', a: 2, b: -0.5 } },
    { label: 'valid at both bounds', input: { mode: 'quadratic', a: -10, b: 10 } },
    { label: 'float noise', input: { mode: 'linear', a: 0.30000000000000004, b: -0.3 } },
    { label: 'missing key', input: { mode: 'linear', a: 2 } },
    { label: 'extra key', input: { mode: 'linear', a: 2, b: 0, c: 1 } },
    { label: 'out of range high', input: { mode: 'linear', a: 10.1, b: 0 } },
    { label: 'out of range low', input: { mode: 'linear', a: -10.1, b: 0 } },
    { label: 'off step', input: { mode: 'linear', a: 0.15, b: 0 } },
    { label: 'string number', input: { mode: 'linear', a: '2', b: 0 } },
    { label: 'bad enum', input: { mode: 'cubic', a: 1, b: 0 } },
    { label: 'null', input: null },
    { label: 'array', input: [1, 2, 3] },
  ];

  it.each(cases)('$label', ({ input }) => {
    const client = normalizeStateValues(SCHEMA, input);
    const server = validateStateValues(serverSchema, input);

    expect(client.ok).toBe(server.ok);
    if (client.ok && server.ok) {
      expect(client.values).toEqual(server.values);
      expect(canonicalStatePayload(SCHEMA, client.values)).toBe(server.payload);
    }
  });
});
