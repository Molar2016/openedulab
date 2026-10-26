import type { ExperimentServices } from '../experiment/contract';
import { createAnalytics, createMemorySink, type AnalyticsAdapter, type MemorySink } from './analytics';
import { createErrorReporter, type ErrorReporter, type ErrorSink } from './errors';

export const APP_VERSION = '0.1.0-m1';

export interface AppServices extends ExperimentServices {
  readonly appVersion: string;
  readonly analytics: AnalyticsAdapter;
  readonly errors: ErrorReporter;
  /** In-memory only; exposed for local debugging and E2E assertions. */
  readonly debug: { analyticsSink: MemorySink };
}

export interface AppServicesOptions {
  /** Analytics is OFF unless explicitly enabled; M1 ships with no endpoint at all. */
  analyticsEnabled?: boolean;
  appVersion?: string;
  errorSink?: ErrorSink;
}

export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const appVersion = options.appVersion ?? APP_VERSION;
  const sink = createMemorySink();
  const analytics = createAnalytics({
    enabled: options.analyticsEnabled ?? false,
    sink,
    appVersion,
  });
  const errors = createErrorReporter({ appVersion, sink: options.errorSink });

  return {
    appVersion,
    analytics,
    errors,
    debug: { analyticsSink: sink },
  };
}
