/**
 * Replaceable error reporter.
 *
 * Deliberately discards messages, stacks, URLs and input values: only a stable error
 * code, the experiment id, the app version and a coarse browser class are kept.
 * With no configured sink (M1 default) reporting is a no-op.
 */
import { ERROR_CODES, type ErrorCode } from '../experiment/contract';

export type BrowserClass = 'chromium' | 'firefox' | 'safari' | 'unknown';

export interface ErrorReport {
  code: ErrorCode;
  experimentId?: string;
  appVersion: string;
  browserClass: BrowserClass;
}

export interface ErrorSink {
  record(report: ErrorReport): void;
}

export interface ErrorReporterOptions {
  sink?: ErrorSink;
  appVersion: string;
  enabled?: boolean;
  /** Injectable UA (tests); defaults to navigator.userAgent when available. */
  userAgent?: string;
}

export interface ErrorReporter {
  report(input: { code: ErrorCode; experimentId?: string; error?: unknown }): void;
}

export function classifyBrowser(userAgent: string): BrowserClass {
  const ua = userAgent || '';
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|Edg\//i.test(ua)) return 'chromium';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'unknown';
}

function defaultUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const enabled = options.enabled ?? true;
  const browserClass = classifyBrowser(options.userAgent ?? defaultUserAgent());

  return {
    report({ code, experimentId }): void {
      if (!enabled || !options.sink) return;
      if (!ERROR_CODES.includes(code)) return;
      // Intentionally do not read `error.message` / `error.stack` / `error.name`.
      const report: ErrorReport = {
        code,
        appVersion: options.appVersion,
        browserClass,
      };
      if (experimentId) report.experimentId = experimentId;
      try {
        options.sink.record(report);
      } catch {
        // Reporting must never break the experiment.
      }
    },
  };
}

export interface MemoryErrorSink extends ErrorSink {
  reports: ErrorReport[];
  clear(): void;
}

export function createMemoryErrorSink(): MemoryErrorSink {
  const reports: ErrorReport[] = [];
  return {
    reports,
    record(report: ErrorReport): void {
      reports.push(report);
    },
    clear(): void {
      reports.length = 0;
    },
  };
}

export const noopErrorReporter: ErrorReporter = Object.freeze({
  report(): void {
    /* intentionally empty */
  },
});
