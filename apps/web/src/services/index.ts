import type { ExperimentServices } from '../experiment/contract';
import { createAnalytics, createMemorySink, type AnalyticsAdapter, type MemorySink } from './analytics';
import { createApiClient, type ApiClient } from './api';
import { createErrorReporter, type ErrorReporter, type ErrorSink } from './errors';

export const APP_VERSION = '0.1.0-m1';

export interface AppServices extends ExperimentServices {
  readonly appVersion: string;
  readonly analytics: AnalyticsAdapter;
  readonly errors: ErrorReporter;
  /** Same-origin API client; the only way the UI reaches the server. */
  readonly api: ApiClient;
  /** In-memory only; exposed for local debugging and E2E assertions. */
  readonly debug: { analyticsSink: MemorySink };
}

export interface AppServicesOptions {
  /** Analytics is OFF unless explicitly enabled; B3 ships with no remote sink yet. */
  analyticsEnabled?: boolean;
  appVersion?: string;
  errorSink?: ErrorSink;
  api?: ApiClient;
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
    api: options.api ?? createApiClient(),
    debug: { analyticsSink: sink },
  };
}
