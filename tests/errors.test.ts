import { describe, expect, it, vi } from 'vitest';
import {
  classifyBrowser,
  createErrorReporter,
  createMemoryErrorSink,
} from '../apps/web/src/services/errors';

describe('error reporter (no stacks, no personal text)', () => {
  it('keeps only code, experiment id, app version and coarse browser class', () => {
    const sink = createMemoryErrorSink();
    const reporter = createErrorReporter({
      sink,
      appVersion: '0.1.0-m1',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    });

    reporter.report({
      code: 'render_error',
      experimentId: 'math.functions',
      error: new Error('token=super-secret student@example.com'),
    });

    expect(sink.reports).toHaveLength(1);
    const report = sink.reports[0] as unknown as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(
      ['appVersion', 'browserClass', 'code', 'experimentId'].sort(),
    );
    expect(report.browserClass).toBe('chromium');
    expect(JSON.stringify(report)).not.toContain('super-secret');
    expect(JSON.stringify(report)).not.toContain('student@example.com');
  });

  it('classifies browsers coarsely and defaults to unknown', () => {
    expect(classifyBrowser('Mozilla/5.0 Firefox/133.0')).toBe('firefox');
    expect(classifyBrowser('Mozilla/5.0 Version/17.0 Safari/605.1.15')).toBe('safari');
    expect(classifyBrowser('')).toBe('unknown');
  });

  it('does nothing when disabled', () => {
    const sink = createMemoryErrorSink();
    const reporter = createErrorReporter({ sink, appVersion: '0.1.0', enabled: false });
    reporter.report({ code: 'unknown_error' });
    expect(sink.reports).toEqual([]);
  });

  it('never throws even if the sink throws', () => {
    const reporter = createErrorReporter({
      appVersion: '0.1.0',
      sink: { record: vi.fn(() => { throw new Error('sink down'); }) },
    });
    expect(() => reporter.report({ code: 'unknown_error' })).not.toThrow();
  });
});
