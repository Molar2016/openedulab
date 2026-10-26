import type { ExperimentServices, SafeExperimentEvent } from '../experiment/contract';
import {
  createAnalytics,
  createBatchingSink,
  createMemorySink,
  type AnalyticsAdapter,
  type AnalyticsSink,
  type MemorySink,
} from './analytics';
import { createApiClient, type ApiClient, type DiagnosticEvent } from './api';
import { createErrorReporter, type ErrorReporter, type ErrorSink } from './errors';

export const APP_VERSION = '0.1.0-m1';

export interface AppServices extends ExperimentServices {
  readonly appVersion: string;
  readonly analytics: AnalyticsAdapter;
  readonly errors: ErrorReporter;
  /** Same-origin API client; the only way the UI reaches the server. */
  readonly api: ApiClient;
  /** Sends anything still queued (pagehide, tests). Never throws. */
  readonly flushAnalytics: () => Promise<void>;
  /** In-memory mirror of the events this visit produced; for tests and local debugging. */
  readonly debug: { analyticsSink: MemorySink };
}

export interface AppServicesOptions {
  /** Analytics is ON by default now that a real endpoint exists; failures stay silent. */
  analyticsEnabled?: boolean;
  appVersion?: string;
  errorSink?: ErrorSink;
  api?: ApiClient;
  /** One id per page load, not persisted (design §5.6). */
  visitId?: string;
  analyticsFlushDelayMs?: number;
}

function newVisitId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
  return `visit-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

function toWire(event: SafeExperimentEvent): DiagnosticEvent {
  return {
    clientEventId: event.clientEventId,
    type: event.type,
    experimentId: event.experimentId,
    contentVersion: event.contentVersion,
    ...(event.locale === undefined ? {} : { locale: event.locale }),
    ...(event.controlGroup === undefined ? {} : { controlGroup: event.controlGroup }),
    ...(event.interactionBucket === undefined
      ? {}
      : { interactionBucket: event.interactionBucket }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
  };
}

/** Writes to two sinks: the debug mirror and the batch sender. Neither may throw. */
function tee(mirror: AnalyticsSink, remote: AnalyticsSink): AnalyticsSink {
  return {
    record(event: SafeExperimentEvent): void {
      try {
        mirror.record(event);
      } catch {
        // A debugging aid must never break the experiment.
      }
      try {
        remote.record(event);
      } catch {
        // Ditto for diagnostics.
      }
    },
  };
}

export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const appVersion = options.appVersion ?? APP_VERSION;
  const api = options.api ?? createApiClient();
  const visitId = options.visitId ?? newVisitId();
  const mirror = createMemorySink();

  const batching = createBatchingSink({
    maxBatch: 10,
    flushDelayMs: options.analyticsFlushDelayMs ?? 400,
    send: async (events) => {
      await api.postEvents({ visitId, appVersion, events: events.map(toWire) });
    },
  });

  const analytics = createAnalytics({
    enabled: options.analyticsEnabled ?? true,
    sink: tee(mirror, batching),
    appVersion,
  });
  const errors = createErrorReporter({ appVersion, sink: options.errorSink });

  return {
    appVersion,
    analytics,
    errors,
    api,
    flushAnalytics: async () => {
      try {
        await batching.flush();
      } catch {
        // Diagnostics are best effort; the UI never waits on them.
      }
    },
    debug: { analyticsSink: mirror },
  };
}
