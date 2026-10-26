import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COEFFICIENTS,
  PARAM_LIMIT,
  ParameterError,
  describeFunction,
  evaluate,
  samplePoints,
  type Coefficients,
} from '../model';

const quad = (a: number, b: number, c: number): Coefficients => ({ mode: 'quadratic', a, b, c });
const line = (a: number, b: number): Coefficients => ({ mode: 'linear', a, b, c: 0 });

describe('linear model y = a·x + b', () => {
  const model = describeFunction(line(2, -1));

  it('evaluates y = 2x − 1 at several x values', () => {
    expect(evaluate(line(2, -1), 0)).toBe(-1);
    expect(evaluate(line(2, -1), 1)).toBe(1);
    expect(evaluate(line(2, -1), -2.5)).toBe(-6);
  });

  it('reports kind, slope, intercept and the single root', () => {
    expect(model.kind).toBe('linear');
    expect(model.slope).toBe(2);
    expect(model.yIntercept).toBe(-1);
    expect(model.roots).toHaveLength(1);
    expect(model.roots[0]).toBeCloseTo(0.5, 12);
    expect(model.vertex).toBeUndefined();
    expect(model.axisOfSymmetry).toBeUndefined();
  });

  it('renders a readable formula', () => {
    expect(model.formula).toBe('y = 2x − 1');
  });

  it('ignores c in linear mode and states that assumption', () => {
    const ignored = describeFunction({ mode: 'linear', a: 3, b: 1, c: 99 });
    expect(ignored.formula).toBe('y = 3x + 1');
    expect(ignored.assumptions).toContain('linear_ignores_c');
  });

  it('has no root when a = 0 and flags a constant function', () => {
    const constant = describeFunction(line(0, 4));
    expect(constant.kind).toBe('constant');
    expect(constant.roots).toEqual([]);
    expect(constant.warnings).toContain('constant_function');
    expect(constant.formula).toBe('y = 4');
  });
});

describe('quadratic model y = a·x² + b·x + c', () => {
  it('finds the vertex, axis and roots of y = x² − 2x', () => {
    const model = describeFunction(quad(1, -2, 0));
    expect(model.kind).toBe('quadratic');
    expect(model.vertex?.x).toBeCloseTo(1, 12);
    expect(model.vertex?.y).toBeCloseTo(-1, 12);
    expect(model.axisOfSymmetry).toBeCloseTo(1, 12);
    expect(model.opening).toBe('up');
    expect(model.roots).toEqual([expect.closeTo(0, 12), expect.closeTo(2, 12)]);
    expect(model.extrema).toEqual({ kind: 'min', point: { x: 1, y: -1 } });
  });

  it('opens downward and reports a maximum when a < 0', () => {
    const model = describeFunction(quad(-1, 0, 4));
    expect(model.opening).toBe('down');
    expect(model.extrema?.kind).toBe('max');
    expect(model.extrema?.point).toEqual({ x: 0, y: 4 });
  });

  it('reports no real roots for x² + 1 but keeps the vertex', () => {
    const model = describeFunction(quad(1, 0, 1));
    expect(model.roots).toEqual([]);
    expect(model.warnings).toContain('no_real_roots');
    expect(model.vertex).toEqual({ x: 0, y: 1 });
  });

  it('reports one double root for x² (discriminant ≈ 0)', () => {
    const model = describeFunction(quad(1, 0, 0));
    expect(model.roots).toEqual([0]);
  });

  it('keeps precision on a double root from a near-zero discriminant', () => {
    const model = describeFunction(quad(0.1, -0.2, 0.1));
    expect(model.roots).toHaveLength(1);
    expect(model.roots[0]).toBeCloseTo(1, 9);
  });

  it('treats a ≈ 0 as a degenerate linear function and warns', () => {
    const model = describeFunction(quad(0, 2, -4));
    expect(model.kind).toBe('linear');
    expect(model.warnings).toContain('degenerate_quadratic');
    expect(model.roots).toEqual([2]);
    expect(model.formula).toBe('y = 2x − 4');
  });
});

describe('parameter validation', () => {
  it('rejects non-finite coefficients', () => {
    expect(() => describeFunction(quad(Number.NaN, 0, 0))).toThrow(ParameterError);
    expect(() => describeFunction(quad(1, Number.POSITIVE_INFINITY, 0))).toThrow(/not_finite/);
  });

  it('rejects coefficients outside the documented range', () => {
    try {
      describeFunction(quad(PARAM_LIMIT.max + 1, 0, 0));
      throw new Error('expected describeFunction to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ParameterError);
      expect((error as ParameterError).code).toBe('out_of_range');
      expect((error as ParameterError).field).toBe('a');
    }
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      describeFunction({ mode: 'cubic' as Coefficients['mode'], a: 1, b: 0, c: 0 }),
    ).toThrow(/unknown_mode/);
  });

  it('rejects a non-finite x when evaluating', () => {
    expect(() => evaluate(line(1, 0), Number.NaN)).toThrow(/not_finite/);
  });
});

describe('sampling for the SVG plot', () => {
  it('includes both domain endpoints and is strictly increasing in x', () => {
    const points = samplePoints(describeFunction(quad(1, 0, 0)), 101);
    expect(points).toHaveLength(101);
    expect(points[0].x).toBeCloseTo(-10, 12);
    expect(points[points.length - 1].x).toBeCloseTo(10, 12);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].x).toBeGreaterThan(points[i - 1].x);
    }
  });

  it('matches evaluate() for a linear model', () => {
    const model = describeFunction(line(-1.5, 2));
    const points = samplePoints(model, 21);
    for (const point of points) {
      expect(point.y).toBeCloseTo(-1.5 * point.x + 2, 10);
    }
  });

  it('clamps the sample count to a safe range', () => {
    const model = describeFunction(quad(1, 0, 0));
    expect(samplePoints(model, 1).length).toBeGreaterThanOrEqual(3);
    expect(samplePoints(model, 100000).length).toBeLessThanOrEqual(2001);
  });
});

describe('defaults', () => {
  it('defaults are a valid, drawable quadratic', () => {
    const model = describeFunction(DEFAULT_COEFFICIENTS);
    expect(model.kind).toBe('quadratic');
    expect(samplePoints(model).length).toBeGreaterThan(0);
  });
});
