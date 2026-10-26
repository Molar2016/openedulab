/**
 * Pure mathematical model for the math-functions experiment.
 *
 * No React, no DOM, no i18n imports: this module is testable in plain Node and is the
 * single source of truth for every number shown by the view.
 *
 * Functions under study (real coefficients):
 *   linear     y = a·x + b        (c is ignored, documented in warnings/assumptions)
 *   quadratic  y = a·x² + b·x + c
 */

export type ExperimentMode = 'linear' | 'quadratic';

export interface Coefficients {
  mode: ExperimentMode;
  a: number;
  b: number;
  c: number;
}

export type EffectiveKind = 'linear' | 'quadratic' | 'constant';

export type ModelWarning =
  | 'degenerate_quadratic'
  | 'constant_function'
  | 'no_real_roots'
  | 'steep_slope';

export type AssumptionCode =
  | 'real_domain'
  | 'linear_ignores_c'
  | 'graph_is_sampled'
  | 'axis_units';

export interface Point {
  x: number;
  y: number;
}

export interface FunctionModel {
  mode: ExperimentMode;
  kind: EffectiveKind;
  coefficients: Readonly<Coefficients>;
  /** Human-readable formula with normalised signs, e.g. "y = x² − 2x". */
  formula: string;
  domain: { min: number; max: number };
  yIntercept: number;
  slope?: number;
  vertex?: Point;
  axisOfSymmetry?: number;
  opening?: 'up' | 'down' | 'constant';
  roots: number[];
  extrema?: { kind: 'min' | 'max'; point: Point };
  warnings: ModelWarning[];
  assumptions: AssumptionCode[];
}

export type ParameterField = 'mode' | 'a' | 'b' | 'c' | 'x';

export type ParameterErrorCode =
  | 'not_finite'
  | 'out_of_range'
  | 'unknown_mode';

export class ParameterError extends Error {
  readonly code: ParameterErrorCode;
  readonly field: ParameterField;

  constructor(code: ParameterErrorCode, field: ParameterField) {
    super(`Invalid parameter "${field}": ${code}`);
    this.name = 'ParameterError';
    this.code = code;
    this.field = field;
  }
}

/** Accepted range for coefficients (wider than the sliders, narrower than absurd). */
export const PARAM_LIMIT = { min: -1000, max: 1000 } as const;

/** Default visible plot window; the view may request other windows. */
export const VIEW = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 } as const;

/** Default parameters, exported so host reset and tests share one definition. */
export const DEFAULT_COEFFICIENTS: Readonly<Coefficients> = Object.freeze({
  mode: 'quadratic',
  a: 1,
  b: 0,
  c: 0,
});

/** Coefficients smaller than this are treated as exactly zero (curve degeneracy). */
const ZERO_EPS = 1e-9;
/** Relative tolerance when deciding whether the discriminant is zero. */
const DISC_EPS = 1e-9;
const DEFAULT_SAMPLE_COUNT = 161;
const MIN_SAMPLE_COUNT = 3;
const MAX_SAMPLE_COUNT = 2001;

function assertMode(mode: string): asserts mode is ExperimentMode {
  if (mode !== 'linear' && mode !== 'quadratic') {
    throw new ParameterError('unknown_mode', 'mode');
  }
}

function assertCoefficient(field: 'a' | 'b' | 'c', value: number): void {
  if (!Number.isFinite(value)) {
    throw new ParameterError('not_finite', field);
  }
  if (value < PARAM_LIMIT.min || value > PARAM_LIMIT.max) {
    throw new ParameterError('out_of_range', field);
  }
}

function normalizeZero(value: number): number {
  return Math.abs(value) < 1e-12 ? 0 : value;
}

/** Up to three decimals, trailing zeros removed; used in formula and readouts. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 1000) / 1000;
  return String(normalizeZero(rounded));
}

function signedTerms(terms: Array<{ value: number; text: string }>): string {
  const parts: string[] = [];
  for (const term of terms) {
    if (Math.abs(term.value) < ZERO_EPS) continue;
    const negative = term.value < 0;
    const prefix = parts.length === 0 ? (negative ? '−' : '') : negative ? '− ' : '+ ';
    parts.push(`${prefix}${term.text}`);
  }
  if (parts.length === 0) return 'y = 0';
  return `y = ${parts.join(' ')}`;
}

function variableTerm(
  coefficient: number,
  variable: string,
  power = '',
): { value: number; text: string } {
  const magnitude = Math.abs(coefficient);
  const magnitudeText = Math.abs(magnitude - 1) < ZERO_EPS ? '' : formatNumber(magnitude);
  return {
    value: coefficient,
    text: `${magnitudeText}${variable}${power}`,
  };
}

function formulaFor(kind: EffectiveKind, a: number, b: number, c: number): string {
  if (kind === 'quadratic') {
    return signedTerms([
      variableTerm(a, 'x', '²'),
      variableTerm(b, 'x'),
      { value: c, text: formatNumber(Math.abs(c)) },
    ]);
  }
  // For linear/constant the slope is passed as `a` and the intercept as `b`.
  return signedTerms([
    variableTerm(a, 'x'),
    { value: b, text: formatNumber(Math.abs(b)) },
  ]);
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  const discriminant = b * b - 4 * a * c;
  const scale = Math.max(1, Math.abs(b * b), Math.abs(4 * a * c));
  if (discriminant < -DISC_EPS * scale) return [];
  if (Math.abs(discriminant) <= DISC_EPS * scale) {
    return [normalizeZero(-b / (2 * a))];
  }
  const sqrtDiscriminant = Math.sqrt(discriminant);
  // Stable quadratic formula: one root from q/a, the other from c/q (Vieta).
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * sqrtDiscriminant);
  const first = q / a;
  const second = c / q;
  return [normalizeZero(first), normalizeZero(second)].sort((left, right) => left - right);
}

export function describeFunction(input: Coefficients): FunctionModel {
  assertMode(input.mode);
  assertCoefficient('a', input.a);
  assertCoefficient('b', input.b);
  assertCoefficient('c', input.c);

  const { mode } = input;
  const a = normalizeZero(input.a);
  const b = normalizeZero(input.b);
  const c = normalizeZero(input.c);
  const warnings: ModelWarning[] = [];
  const assumptions: AssumptionCode[] = ['real_domain', 'graph_is_sampled', 'axis_units'];

  let kind: EffectiveKind;
  let slope: number | undefined;
  let yIntercept: number;
  let roots: number[];
  let vertex: Point | undefined;
  let axisOfSymmetry: number | undefined;
  let opening: 'up' | 'down' | 'constant' | undefined;
  let extrema: FunctionModel['extrema'];

  if (mode === 'quadratic' && Math.abs(a) < ZERO_EPS) {
    warnings.push('degenerate_quadratic');
  }

  if (mode === 'quadratic' && Math.abs(a) >= ZERO_EPS) {
    kind = 'quadratic';
    slope = undefined;
    yIntercept = c;
    roots = quadraticRoots(a, b, c);
    if (roots.length === 0) warnings.push('no_real_roots');
    const vertexX = -b / (2 * a);
    vertex = { x: normalizeZero(vertexX), y: normalizeZero(c - (b * b) / (4 * a)) };
    axisOfSymmetry = vertex.x;
    opening = a > 0 ? 'up' : 'down';
    extrema = { kind: a > 0 ? 'min' : 'max', point: vertex };
    if (Math.abs(a) > 50) warnings.push('steep_slope');
    return finish('quadratic', a, b, c);
  } else {
    // linear: y = a·x + b; degenerate quadratic: y = b·x + c
    const slopeCoefficient = mode === 'linear' ? a : b;
    const interceptCoefficient = mode === 'linear' ? b : c;
    kind = Math.abs(slopeCoefficient) < ZERO_EPS ? 'constant' : 'linear';
    slope = kind === 'constant' ? 0 : slopeCoefficient;
    yIntercept = interceptCoefficient;
    if (kind === 'constant') {
      warnings.push('constant_function');
      roots = [];
    } else {
      roots = [normalizeZero(-interceptCoefficient / slopeCoefficient)];
    }
    opening = 'constant';
    return finish(kind, slopeCoefficient, interceptCoefficient, interceptCoefficient);
  }

  function finish(
    effectiveKind: EffectiveKind,
    formulaA: number,
    formulaB: number,
    formulaC: number,
  ): FunctionModel {
    if (mode === 'linear') assumptions.push('linear_ignores_c');
    return {
      mode,
      kind: effectiveKind,
      coefficients: Object.freeze({ mode, a, b, c }),
      formula: formulaFor(effectiveKind, formulaA, formulaB, formulaC),
      domain: { min: VIEW.xMin, max: VIEW.xMax },
      yIntercept,
      slope,
      vertex,
      axisOfSymmetry,
      opening,
      roots,
      extrema,
      warnings,
      assumptions,
    };
  }
}

export function evaluate(
  coefficients: Pick<Coefficients, 'mode' | 'a' | 'b' | 'c'>,
  x: number,
): number {
  if (!Number.isFinite(x)) {
    throw new ParameterError('not_finite', 'x');
  }
  assertMode(coefficients.mode);
  assertCoefficient('a', coefficients.a);
  assertCoefficient('b', coefficients.b);
  assertCoefficient('c', coefficients.c);

  if (coefficients.mode === 'linear') {
    return coefficients.a * x + coefficients.b;
  }
  return coefficients.a * x * x + coefficients.b * x + coefficients.c;
}

export function samplePoints(model: FunctionModel, count = DEFAULT_SAMPLE_COUNT): Point[] {
  const safeCount = Math.min(
    MAX_SAMPLE_COUNT,
    Math.max(
      MIN_SAMPLE_COUNT,
      Math.round(Number.isFinite(count) ? count : DEFAULT_SAMPLE_COUNT),
    ),
  );
  const { min, max } = model.domain;
  const step = (max - min) / (safeCount - 1);
  const points: Point[] = [];
  for (let index = 0; index < safeCount; index += 1) {
    const x = index === safeCount - 1 ? max : min + step * index;
    points.push({ x, y: evaluate(model.coefficients, x) });
  }
  return points;
}
